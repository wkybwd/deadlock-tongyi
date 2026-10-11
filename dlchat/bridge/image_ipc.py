"""Loopback image transport: idempotent jobs and dimension-encoded TYI1 frames.

Each PNG carries two wire bytes as (width - 1, height - 1). The wire header
contains the compressed length, UTF-8 JSON length and CRC32 of that JSON.
Compression is an independent literal/back-reference format, with no external
dependencies or game-specific code.
"""

from __future__ import annotations

from collections import OrderedDict, defaultdict, deque
from dataclasses import dataclass
from functools import lru_cache
import hashlib
import json
import logging
import re
import struct
import threading
import time
from typing import Any, Callable
import zlib


logger = logging.getLogger(__name__)
MAGIC = b"TYI1"
HEADER_SIZE = 12
MAX_RAW = 8192
MAX_PACKED = 8256
MAX_FRAME = HEADER_SIZE + MAX_PACKED
MAX_PARTS = (MAX_FRAME + 1) // 2
ID_RE = re.compile(r"[A-Za-z0-9_.:-]{1,96}\Z", re.ASCII)
OP_RE = re.compile(r"[a-z]+(?:/[a-z]+)?\Z", re.ASCII)


class IPCError(Exception):
    def __init__(self, status: int, error: str) -> None:
        self.status = status
        self.error = error
        super().__init__(error)


def validate_id(request_id: str) -> None:
    if not isinstance(request_id, str) or not ID_RE.fullmatch(request_id):
        raise IPCError(400, "ipc_bad_id")


def compress_lzss(raw: bytes) -> bytes:
    """Greedily encode literal runs (1..128) and matches (3..130).

    A match token is followed by its little-endian 16-bit backward distance.
    Overlapping matches are valid; the decoder copies one byte at a time.
    The four-byte hash table tracks every consumed position, including matches.
    """
    positions: dict[bytes, deque[int]] = defaultdict(lambda: deque(maxlen=64))
    output = bytearray()
    literals = bytearray()
    index = 0

    def flush_literals() -> None:
        if literals:
            output.append(len(literals) - 1)
            output.extend(literals)
            literals.clear()

    def remember(start: int, end: int) -> None:
        for offset in range(start, end):
            if offset + 4 <= len(raw):
                positions[raw[offset:offset + 4]].append(offset)

    while index < len(raw):
        length = 0
        distance = 0
        if index + 4 <= len(raw):
            limit = min(130, len(raw) - index)
            for previous in reversed(positions.get(raw[index:index + 4], ())):
                gap = index - previous
                if gap > 65535:
                    break
                match = 4
                while match < limit and raw[previous + match] == raw[index + match]:
                    match += 1
                if match > length:
                    length, distance = match, gap
                if length == limit:
                    break
        if length >= 4:
            flush_literals()
            output.append(128 | (length - 3))
            output.extend(struct.pack("<H", distance))
            remember(index, index + length)
            index += length
        else:
            literals.append(raw[index])
            remember(index, index + 1)
            index += 1
            if len(literals) == 128:
                flush_literals()
    flush_literals()
    return bytes(output)


def encode_result(request_id: str, result: Any) -> bytes:
    validate_id(request_id)

    def serialize(value: Any) -> bytes:
        return json.dumps(
            {"id": request_id, "result": value}, ensure_ascii=False,
            separators=(",", ":"), allow_nan=False,
        ).encode("utf-8")

    try:
        raw = serialize(result)
    except (TypeError, ValueError, UnicodeError, RecursionError):
        raw = serialize({"ok": False, "error": "ipc_response_invalid"})
    if len(raw) > MAX_RAW:
        raw = serialize({"ok": False, "error": "ipc_response_too_large"})
    packed = compress_lzss(raw)
    if len(packed) > MAX_PACKED:
        # Literal runs add at most ceil(MAX_RAW / 128) bytes, so reaching this
        # branch indicates an encoder defect rather than a large user response.
        raise ValueError("Image IPC packed frame exceeded its wire limit")
    return struct.pack("<4sHHI", MAGIC, len(packed), len(raw), zlib.crc32(raw)) + packed


@lru_cache(maxsize=256)
def png_bytes(width: int, height: int) -> bytes:
    if not (1 <= width <= 256 and 1 <= height <= 256):
        raise ValueError("PNG dimensions must be between 1 and 256")

    def chunk(kind: bytes, payload: bytes) -> bytes:
        return (struct.pack(">I", len(payload)) + kind + payload
                + struct.pack(">I", zlib.crc32(kind + payload)))

    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    pixels = bytes((width * 4 + 1) * height)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header)
            + chunk(b"IDAT", zlib.compress(pixels)) + chunk(b"IEND", b""))


@dataclass
class _Job:
    fingerprint: bytes
    op: str
    created_at: float
    completed_at: float | None = None
    frame: bytes | None = None


class ImageIPC:
    """Bounded asynchronous API jobs shared by both loopback HTTP listeners."""

    def __init__(
        self,
        execute: Callable[[str, dict[str, Any]], Any],
        *,
        ttl: float = 240.0,
        max_jobs: int = 64,
        max_active: int = 8,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if ttl <= 0 or max_jobs <= 0 or not 1 <= max_active <= max_jobs:
            raise ValueError("Invalid image IPC cache bounds")
        self.execute = execute
        self.ttl = ttl
        self.max_jobs = max_jobs
        self.max_active = max_active
        self.clock = clock
        self._lock = threading.Lock()
        self._jobs: OrderedDict[str, _Job] = OrderedDict()
        self._active = 0

    def _expire_locked(self) -> None:
        now = self.clock()
        for request_id, job in list(self._jobs.items()):
            # Keep pending jobs reserved: expiring a running settings write could
            # execute it twice on a retry. API operations have their own timeouts.
            if job.completed_at is not None and now - job.completed_at >= self.ttl:
                del self._jobs[request_id]

    def start(self, request_id: str, op: str, payload: dict[str, Any]) -> None:
        validate_id(request_id)
        if not isinstance(op, str) or len(op) > 32 or not OP_RE.fullmatch(op):
            raise IPCError(400, "ipc_bad_op")
        if not isinstance(payload, dict):
            raise IPCError(400, "ipc_bad_json")
        try:
            canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True,
                                   separators=(",", ":"), allow_nan=False).encode("utf-8")
        except (TypeError, ValueError, UnicodeError, RecursionError):
            raise IPCError(400, "ipc_bad_json") from None
        fingerprint = hashlib.sha256(op.encode("ascii") + b"\x00" + canonical).digest()
        # Give the worker its own detached copy; callers cannot change a queued
        # operation after the idempotency fingerprint has been calculated.
        worker_payload = json.loads(canonical)
        with self._lock:
            self._expire_locked()
            job = self._jobs.get(request_id)
            if job is not None:
                if job.fingerprint != fingerprint:
                    raise IPCError(409, "ipc_id_conflict")
                self._jobs.move_to_end(request_id)
                return
            if self._active >= self.max_active:
                raise IPCError(429, "ipc_busy")
            if len(self._jobs) >= self.max_jobs:
                victim = next((key for key, value in self._jobs.items()
                               if value.completed_at is not None), None)
                if victim is None:
                    raise IPCError(429, "ipc_cache_full")
                del self._jobs[victim]
            job = _Job(fingerprint=fingerprint, op=op, created_at=self.clock())
            self._jobs[request_id] = job
            self._active += 1
            worker = threading.Thread(target=self._run, args=(request_id, job, worker_payload),
                                      name="bridge-image-ipc", daemon=True)
            try:
                worker.start()
            except RuntimeError:
                del self._jobs[request_id]
                self._active -= 1
                raise IPCError(503, "ipc_worker_unavailable") from None

    def _run(self, request_id: str, job: _Job, payload: dict[str, Any]) -> None:
        try:
            result = self.execute(job.op, payload)
        except Exception as error:  # The exception text may contain request secrets.
            logger.error("图片通信操作异常 id=%s op=%s type=%s",
                         request_id, job.op, type(error).__name__)
            result = {"ok": False, "error": "ipc_internal_error"}
        try:
            frame = encode_result(request_id, result)
        except Exception:
            logger.error("图片通信编码异常 id=%s op=%s", request_id, job.op)
            frame = encode_result(request_id, {"ok": False, "error": "ipc_internal_error"})
        with self._lock:
            job.frame = frame
            job.completed_at = self.clock()
            self._active -= 1
        logger.info("图片通信完成 id=%s op=%s bytes=%d", request_id, job.op, len(frame))

    def read_pair(self, request_id: str, part: int) -> tuple[int, int]:
        validate_id(request_id)
        if isinstance(part, bool) or not isinstance(part, int) or not 0 <= part < MAX_PARTS:
            raise IPCError(400, "ipc_bad_part")
        with self._lock:
            self._expire_locked()
            job = self._jobs.get(request_id)
            if job is None:
                raise IPCError(404, "ipc_missing")
            if job.frame is None:
                raise IPCError(425, "ipc_pending")
            offset = part * 2
            if offset >= len(job.frame):
                raise IPCError(400, "ipc_bad_part")
            self._jobs.move_to_end(request_id)
            return job.frame[offset], job.frame[offset + 1] if offset + 1 < len(job.frame) else 0
