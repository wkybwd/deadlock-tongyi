"""Offline wire, idempotency and dual-loopback tests for image IPC."""

from concurrent.futures import ThreadPoolExecutor
import io
import json
from pathlib import Path
import random
import socket
import struct
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from unittest.mock import patch
import zlib

from dlchat.bridge.image_ipc import (HEADER_SIZE, IPCError, ImageIPC, MAX_PACKED,
                                    MAX_PARTS, MAX_RAW, compress_lzss,
                                    encode_result, png_bytes)
from dlchat.bridge.server import BridgeServer, _Handler


def unpack_tokens(packed):
    """Reference reader of the wire specification, independent of the encoder."""
    output = bytearray()
    cursor = 0
    tokens = []
    while cursor < len(packed):
        token = packed[cursor]
        cursor += 1
        if token < 128:
            length = token + 1
            if cursor + length > len(packed):
                raise ValueError("short literal")
            output.extend(packed[cursor:cursor + length])
            cursor += length
            tokens.append(("literal", length, None))
        else:
            length = (token & 127) + 3
            if cursor + 2 > len(packed):
                raise ValueError("short match")
            distance = packed[cursor] + packed[cursor + 1] * 256
            cursor += 2
            if not 1 <= distance <= len(output):
                raise ValueError("bad distance")
            for _ in range(length):
                output.append(output[-distance])
            tokens.append(("match", length, distance))
        if len(output) > MAX_RAW:
            raise ValueError("raw limit")
    return bytes(output), tokens


def decode_frame(wire):
    if len(wire) < HEADER_SIZE or wire[:4] != b"TYI1":
        raise ValueError("bad header")
    packed_len, raw_len, checksum = struct.unpack_from("<HHI", wire, 4)
    if packed_len > MAX_PACKED or raw_len > MAX_RAW:
        raise ValueError("frame limit")
    if len(wire) != HEADER_SIZE + packed_len:
        raise ValueError("frame length")
    raw, _ = unpack_tokens(wire[HEADER_SIZE:])
    if len(raw) != raw_len or zlib.crc32(raw) != checksum:
        raise ValueError("raw length or CRC")
    return json.loads(raw.decode("utf-8"))


def png_size(png):
    """Read and verify chunks, CRC and decompressed RGBA scanlines."""
    if png[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("PNG signature")
    cursor = 8
    pixels = bytearray()
    width = height = None
    ended = False
    while cursor < len(png):
        size = struct.unpack_from(">I", png, cursor)[0]
        kind = png[cursor + 4:cursor + 8]
        data = png[cursor + 8:cursor + 8 + size]
        crc = struct.unpack_from(">I", png, cursor + 8 + size)[0]
        if crc != zlib.crc32(kind + data):
            raise ValueError("PNG CRC")
        cursor += size + 12
        if kind == b"IHDR":
            width, height, depth, mode, compression, filtering, interlace = struct.unpack(
                ">IIBBBBB", data)
            if (depth, mode, compression, filtering, interlace) != (8, 6, 0, 0, 0):
                raise ValueError("PNG format")
        elif kind == b"IDAT":
            pixels.extend(data)
        elif kind == b"IEND":
            ended = True
            break
    if not ended or cursor != len(png) or width is None:
        raise ValueError("PNG structure")
    if zlib.decompress(pixels) != bytes((width * 4 + 1) * height):
        raise ValueError("PNG pixels")
    return width, height


def wait_until(predicate, timeout=3):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.005)
    raise AssertionError("timed out waiting for offline job")


def cache_wire(cache, request_id):
    def ready():
        try:
            cache.read_pair(request_id, 0)
            return True
        except IPCError as error:
            if error.status != 425:
                raise
            return False

    wait_until(ready)
    head = bytes(value for part in range(6) for value in cache.read_pair(request_id, part))
    size = HEADER_SIZE + int.from_bytes(head[4:6], "little")
    wire = bytes(value for part in range((size + 1) // 2)
                 for value in cache.read_pair(request_id, part))
    return wire[:size]


class ImageWireTest(unittest.TestCase):
    def test_malformed_ipc_requests_cannot_log_the_original_query(self):
        class MemorySocket:
            def __init__(self, request):
                self.request = io.BytesIO(request)
                self.response = bytearray()

            def makefile(self, mode, size):
                return self.request

            def sendall(self, data):
                self.response.extend(data)

        for target in ("/ipc/start.png?id=x&op=test&d=private-key",
                       "http://127.0.0.1/ipc/start.png?d=private-key"):
            for ending in ("HTTP/x.y", "HTTP/1.1 EXTRA"):
                with self.subTest(target=target, ending=ending):
                    connection = MemorySocket(f"GET {target} {ending}\r\n\r\n".encode("ascii"))
                    with patch("dlchat.bridge.server.logger.debug") as debug:
                        _Handler(connection, ("127.0.0.1", 0), object())
                    self.assertIn(b"400", connection.response.split(b"\r\n", 1)[0])
                    debug.assert_not_called()
        connection = MemorySocket(b"GET /non-ipc HTTP/x.y\r\n\r\n")
        with patch("dlchat.bridge.server.logger.debug") as debug:
            _Handler(connection, ("127.0.0.1", 0), object())
        self.assertTrue(debug.called)

    def test_golden_frames_cross_language(self):
        fixtures = [
            ("g1", "hello",
             "545949313700360045324760357b226964223a226731222c22726573756c74223a7b226f6b223a747275652c227472616e736c6174696f6e223a2268656c6c6f227d7d"),
            ("g2", "你好，世界🌍",
             "5459493145004400859d80fc437b226964223a226732222c22726573756c74223a7b226f6b223a747275652c227472616e736c6174696f6e223a22e4bda0e5a5bdefbc8ce4b896e7958cf09f8c8d227d7d"),
            ("g3", "abc" * 48,
             "545949313c00c100a1974f0a307b226964223a226733222c22726573756c74223a7b226f6b223a747275652c227472616e736c6174696f6e223a22616263ff030088030002227d7d"),
        ]
        for request_id, text, golden in fixtures:
            with self.subTest(request_id=request_id):
                expected = {"id": request_id, "result": {"ok": True, "translation": text}}
                wire = encode_result(request_id, expected["result"])
                self.assertEqual(wire.hex(), golden)
                self.assertEqual(decode_frame(bytes.fromhex(golden)), expected)

    def test_crc_detects_valid_json_with_modified_translation(self):
        wire = bytearray(encode_result("crc", {"translation": "hello"}))
        wire[wire.index(b"hello")] = ord("j")
        with self.assertRaisesRegex(ValueError, "CRC"):
            decode_frame(wire)
        wire = bytearray(encode_result("crc", {"ok": True}))
        wire[8] ^= 1
        with self.assertRaisesRegex(ValueError, "CRC"):
            decode_frame(wire)

    def test_literal_boundaries_and_match_overlap(self):
        for length, literal_lengths in ((128, [128]), (129, [128, 1])):
            raw = bytes(range(length))
            unpacked, tokens = unpack_tokens(compress_lzss(raw))
            self.assertEqual(unpacked, raw)
            self.assertEqual([entry[1] for entry in tokens], literal_lengths)
        raw = b"abc" * 100
        unpacked, tokens = unpack_tokens(compress_lzss(raw))
        self.assertEqual(unpacked, raw)
        self.assertIn(("match", 130, 3), tokens)
        self.assertTrue(all(3 <= length <= 130 for kind, length, _ in tokens
                            if kind == "match"))
        # A legal three-byte match must also be accepted by the reference reader.
        self.assertEqual(unpack_tokens(b"\x02abc\x80\x03\x00")[0], b"abcabc")

    def test_dictionary_updates_inside_consumed_matches(self):
        raw = b"abcdefgh" * 25 + b"X" + b"defghabc" * 18
        unpacked, tokens = unpack_tokens(compress_lzss(raw))
        self.assertEqual(unpacked, raw)
        self.assertTrue(any(kind == "match" and length > 8 for kind, length, _ in tokens))

    def test_maximum_payload_and_incompressible_bound(self):
        rng = random.Random(20261011)
        for length in (0, 1, 3, 127, 128, 129, 4096, MAX_RAW):
            for raw in (bytes(rng.randrange(256) for _ in range(length)), b"Z" * length):
                with self.subTest(length=length, prefix=raw[:4]):
                    packed = compress_lzss(raw)
                    self.assertLessEqual(len(packed), length + (length + 127) // 128)
                    self.assertLessEqual(len(packed), MAX_PACKED)
                    self.assertEqual(unpack_tokens(packed)[0], raw)
        overhead = len(json.dumps({"id": "max", "result": ""}, separators=(",", ":")))
        result = "x" * (MAX_RAW - overhead)
        wire = encode_result("max", result)
        self.assertEqual(struct.unpack_from("<H", wire, 6)[0], MAX_RAW)
        self.assertEqual(decode_frame(wire)["result"], result)
        result += "x"
        self.assertEqual(decode_frame(encode_result("max", result))["result"],
                         {"ok": False, "error": "ipc_response_too_large"})

    def test_invalid_response_has_a_readable_serializable_result(self):
        for result in (object(), {"number": float("nan")}, "\ud800"):
            with self.subTest(kind=type(result).__name__):
                self.assertEqual(decode_frame(encode_result("bad", result))["result"],
                                 {"ok": False, "error": "ipc_response_invalid"})

    def test_png_full_byte_dimensions_and_crc(self):
        for width, height in ((1, 1), (17, 29), (256, 256), (1, 256), (256, 1)):
            self.assertEqual(png_size(png_bytes(width, height)), (width, height))
        for dimensions in ((0, 1), (1, 0), (257, 1), (1, 257)):
            with self.assertRaises(ValueError):
                png_bytes(*dimensions)


class ImageJobTest(unittest.TestCase):
    def assert_ipc_error(self, status, name, function, *args):
        with self.assertRaises(IPCError) as raised:
            function(*args)
        self.assertEqual((raised.exception.status, raised.exception.error), (status, name))

    def test_concurrent_retries_execute_once_and_reuse_completed_job(self):
        entered = threading.Event()
        release = threading.Event()
        calls = []
        barrier = threading.Barrier(12)

        def execute(op, payload):
            calls.append((op, payload))
            entered.set()
            release.wait(3)
            return {"ok": True, "translation": "重试也只翻译一次🌍"}

        cache = ImageIPC(execute)

        def retry(index):
            barrier.wait(3)
            payload = {"text": "secret", "target": "zh"} if index % 2 else {
                "target": "zh", "text": "secret"}
            cache.start("same", "translate", payload)

        try:
            with ThreadPoolExecutor(max_workers=12) as pool:
                futures = [pool.submit(retry, index) for index in range(12)]
                for future in futures:
                    future.result(3)
            self.assertTrue(entered.wait(1))
            self.assertEqual(len(calls), 1)
            self.assert_ipc_error(425, "ipc_pending", cache.read_pair, "same", 0)
            self.assert_ipc_error(409, "ipc_id_conflict", cache.start,
                                  "same", "translate", {"text": "different"})
            self.assert_ipc_error(409, "ipc_id_conflict", cache.start,
                                  "same", "settings", {"text": "secret", "target": "zh"})
        finally:
            release.set()
        first = cache_wire(cache, "same")
        cache.start("same", "translate", {"target": "zh", "text": "secret"})
        self.assertEqual(cache_wire(cache, "same"), first)
        self.assertEqual(len(calls), 1)
        self.assertEqual(decode_frame(first)["result"]["translation"], "重试也只翻译一次🌍")

    def test_worker_gets_detached_payload(self):
        entered = threading.Event()
        release = threading.Event()

        def execute(op, payload):
            entered.set()
            release.wait(3)
            return payload

        cache = ImageIPC(execute)
        payload = {"nested": {"key": "original"}}
        cache.start("detached", "settings", payload)
        try:
            self.assertTrue(entered.wait(1))
            payload["nested"]["key"] = "changed"
        finally:
            release.set()
        self.assertEqual(decode_frame(cache_wire(cache, "detached"))["result"],
                         {"nested": {"key": "original"}})

    def test_active_bound_retries_and_completed_lru_eviction(self):
        entered = threading.Event()
        release = threading.Event()

        def execute(op, payload):
            if payload.get("wait"):
                entered.set()
                release.wait(3)
            return {"ok": True}

        cache = ImageIPC(execute, max_jobs=2, max_active=1)
        cache.start("pending", "test", {"wait": True})
        try:
            self.assertTrue(entered.wait(1))
            cache.start("pending", "test", {"wait": True})
            self.assert_ipc_error(429, "ipc_busy", cache.start, "busy", "test", {})
        finally:
            release.set()
        cache_wire(cache, "pending")
        cache.start("second", "test", {})
        cache_wire(cache, "second")
        cache.read_pair("pending", 0)  # This becomes the newer completed entry.
        cache.start("third", "test", {})
        cache_wire(cache, "third")
        self.assert_ipc_error(404, "ipc_missing", cache.read_pair, "second", 0)
        self.assertEqual(decode_frame(cache_wire(cache, "pending"))["id"], "pending")

    def test_ttl_is_fixed_from_completion_and_pending_ids_stay_reserved(self):
        now = [10.0]
        calls = []
        cache = ImageIPC(lambda op, payload: calls.append(op) or {"ok": True},
                         ttl=5, clock=lambda: now[0])
        cache.start("ttl", "test", {})
        cache_wire(cache, "ttl")
        now[0] = 14.9
        cache.start("ttl", "test", {})
        cache_wire(cache, "ttl")
        self.assertEqual(len(calls), 1)
        now[0] = 15.0
        self.assert_ipc_error(404, "ipc_missing", cache.read_pair, "ttl", 0)
        cache.start("ttl", "test", {})
        cache_wire(cache, "ttl")
        self.assertEqual(len(calls), 2)

        entered = threading.Event()
        release = threading.Event()

        def execute(op, payload):
            calls.append(op)
            entered.set()
            release.wait(3)
            return {"ok": True}

        pending = ImageIPC(execute, ttl=5, clock=lambda: now[0])
        pending.start("reserved", "settings", {})
        try:
            self.assertTrue(entered.wait(1))
            now[0] += 500
            pending.start("reserved", "settings", {})
            self.assertEqual(len(calls), 3)
            self.assert_ipc_error(425, "ipc_pending", pending.read_pair, "reserved", 0)
        finally:
            release.set()
        cache_wire(pending, "reserved")

    def test_bad_parameters_missing_and_past_end_parts(self):
        cache = ImageIPC(lambda op, payload: {"ok": True})
        for request_id in ("", "a" * 97, "含中文", "line\n", "a b", None):
            self.assert_ipc_error(400, "ipc_bad_id", cache.start, request_id, "test", {})
        for op in ("", "\n", "设置", "../test", "a" * 33, None):
            self.assert_ipc_error(400, "ipc_bad_op", cache.start, "valid", op, {})
        for payload in (None, [], {"bad": float("nan")}, {"bad": "\ud800"}):
            self.assert_ipc_error(400, "ipc_bad_json", cache.start, "valid", "test", payload)
        self.assert_ipc_error(404, "ipc_missing", cache.read_pair, "unknown", 0)
        for part in (-1, MAX_PARTS, True, "0", 0.5):
            self.assert_ipc_error(400, "ipc_bad_part", cache.read_pair, "unknown", part)
        cache.start("valid", "test", {})
        wire = cache_wire(cache, "valid")
        self.assert_ipc_error(400, "ipc_bad_part", cache.read_pair, "valid", (len(wire) + 1) // 2)
        if len(wire) % 2:
            self.assertEqual(cache.read_pair("valid", len(wire) // 2)[1], 0)

    def test_exception_response_and_logs_do_not_disclose_payload(self):
        secret = "secret-chat-and-api-key-do-not-log"

        def execute(op, payload):
            raise RuntimeError(secret)

        cache = ImageIPC(execute)
        with self.assertLogs("dlchat.bridge.image_ipc", level="INFO") as logs:
            cache.start("error-id", "settings", {"api_key": secret, "text": secret})
            result = decode_frame(cache_wire(cache, "error-id"))["result"]
            wait_until(lambda: any("bytes=" in line for line in logs.output))
        self.assertEqual(result, {"ok": False, "error": "ipc_internal_error"})
        joined = "\n".join(logs.output)
        self.assertNotIn(secret, joined)
        self.assertIn("id=error-id op=settings", joined)
        self.assertIn("RuntimeError", joined)

    def test_thread_start_failure_rolls_back_reservation(self):
        cache = ImageIPC(lambda op, payload: {"ok": True}, max_jobs=1, max_active=1)
        with patch("dlchat.bridge.image_ipc.threading.Thread.start", side_effect=RuntimeError):
            self.assert_ipc_error(503, "ipc_worker_unavailable", cache.start, "retry", "test", {})
        cache.start("retry", "test", {})
        self.assertTrue(decode_frame(cache_wire(cache, "retry"))["result"]["ok"])


class _OfflineApp:
    def __init__(self, directory):
        self.access_log_path = Path(directory) / "http.log"
        self.calls = []
        self.entered = threading.Event()
        self.release = threading.Event()

    def health(self):
        return {"ok": True, "status": "offline"}

    def game_names(self):
        return {"ok": True, "names": ["英雄", "item"]}

    def config_view(self):
        return {"ok": True, "config": {"recv": True}}

    def translate(self, text, source, target):
        self.calls.append((text, source, target))
        if text == "blocked":
            self.entered.set()
            self.release.wait(3)
        if text == "exception":
            raise RuntimeError("exception-with-secret-content")
        return {"ok": True, "translation": "你好，世界🌍", "echo": text,
                "source": source, "target": target}

    def test(self):
        return {"ok": True, "translation": "测试"}

    def settings_view(self, compact=False):
        return {"ok": True, "compact": compact, "settings": {"recv": True}}

    def update_settings(self, payload):
        return {"ok": True, "updated": payload}

    def settings_test(self, text):
        return {"ok": True, "translation": "设置测试", "text": text}

    def list_models(self, provider):
        return {"ok": True, "provider": provider, "models": ["offline-model"]}

    def read_game_log(self, since, limit):
        return {"ok": True, "since": since, "limit": limit, "entries": []}

    def clear_game_log(self):
        return {"ok": True, "cleared": True}

    def record_game_log(self, payload):
        return {"ok": True, "recorded": payload}


class ImageHTTPTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.app = _OfflineApp(cls.temporary.name)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            cls.port = sock.getsockname()[1]
        cls.server = BridgeServer(cls.app, cls.port)
        cls.server.start()
        cls.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    @classmethod
    def tearDownClass(cls):
        cls.app.release.set()
        cls.server.stop()
        cls.temporary.cleanup()

    def request(self, path, host="127.0.0.1", payload=None):
        url = f"http://{host}:{self.port}{path}"
        request = urllib.request.Request(url)
        if payload is not None:
            request.data = json.dumps(payload).encode("utf-8")
            request.add_header("Content-Type", "application/json")
        try:
            with self.opener.open(request, timeout=3) as response:
                return response.status, response.headers, response.read()
        except urllib.error.HTTPError as error:
            return error.code, error.headers, error.read()

    def start(self, request_id, op, payload, host="127.0.0.1"):
        query = urllib.parse.urlencode({"id": request_id, "op": op,
                                       "d": json.dumps(payload, ensure_ascii=False)})
        return self.request("/ipc/start.png?" + query, host)

    def read(self, request_id, part, host="127.0.0.1", nonce="random-0"):
        query = urllib.parse.urlencode({"id": request_id, "part": part, "nonce": nonce})
        return self.request("/ipc/read.png?" + query, host)

    def read_wire(self, request_id, host="127.0.0.1"):
        def ready():
            status, _, _ = self.read(request_id, 0, host)
            if status not in (200, 425):
                raise AssertionError(f"unexpected IPC status {status}")
            return status == 200

        wait_until(ready)
        wire = bytearray()
        size = HEADER_SIZE
        part = 0
        while len(wire) < size:
            status, headers, body = self.read(request_id, part, host, f"read-{part}")
            self.assertEqual(status, 200)
            self.assertEqual(headers["Content-Type"], "image/png")
            self.assertEqual(headers["Cache-Control"], "no-store")
            width, height = png_size(body)
            wire.extend((width - 1, height - 1))
            if len(wire) == HEADER_SIZE:
                size += int.from_bytes(wire[4:6], "little")
            part += 1
        if len(wire) != size:
            self.assertEqual(wire[-1], 0)
        return bytes(wire[:size])

    def test_probe_and_dualstack_start_read_share_a_job(self):
        status, _, body = self.request("/ipc/probe.png")
        self.assertEqual(status, 200)
        self.assertEqual(png_size(body), (17, 29))
        payload = {"text": "网络离线也能测", "sourceLanguage": "en", "targetLanguage": "zh-Hans"}
        status, _, body = self.start("http-unicode", "translate", payload)
        self.assertEqual(status, 200)
        self.assertEqual(png_size(body), (1, 1))
        ipv4 = decode_frame(self.read_wire("http-unicode"))
        self.assertEqual(ipv4["result"]["translation"], "你好，世界🌍")
        self.assertEqual(ipv4["result"]["echo"], payload["text"])
        if not any(server.address_family == socket.AF_INET6 for server in self.server._servers):
            self.skipTest("IPv6 loopback unavailable")
        self.assertEqual(decode_frame(self.read_wire("http-unicode", "[::1]")), ipv4)
        self.assertEqual(self.start("http-ipv6", "health", {}, "[::1]")[0], 200)
        self.assertEqual(decode_frame(self.read_wire("http-ipv6"))["result"], self.app.health())
        status, _, body = self.request("/ipc/probe.png", "[::1]")
        self.assertEqual((status, png_size(body)), (200, (17, 29)))

    def test_all_operations_share_the_existing_json_api_results(self):
        cases = [
            ("health", {}), ("config", {}), ("gamenames", {}), ("test", {}),
            ("translate", {"text": "same dispatch", "sourceLanguage": "en", "targetLanguage": "zh"}),
            ("settings", {"view": "compact"}), ("settings", {"recv": False}),
            ("settings/test", {"text": "example"}), ("models", {"provider": "d"}),
            ("log", {"op": "read", "since": 123, "limit": 4}),
            ("log", {"op": "clear"}), ("log", {"msg": "example"}),
        ]
        for index, (op, payload) in enumerate(cases):
            with self.subTest(op=op, payload=payload):
                status, _, direct = self.request("/api/v1/" + op, payload=payload)
                self.assertEqual(status, 200)
                request_id = f"dispatch-{index}"
                self.assertEqual(self.start(request_id, op, payload)[0], 200)
                self.assertEqual(decode_frame(self.read_wire(request_id))["result"], json.loads(direct))

    def test_http_pending_concurrent_retry_conflict_and_nonce(self):
        self.app.entered.clear()
        self.app.release.clear()
        before = len(self.app.calls)
        payload = {"text": "blocked"}
        try:
            with ThreadPoolExecutor(max_workers=6) as pool:
                futures = [pool.submit(self.start, "http-once", "translate", payload) for _ in range(6)]
                for future in futures:
                    self.assertEqual(future.result(3)[0], 200)
            self.assertTrue(self.app.entered.wait(1))
            self.assertEqual(len(self.app.calls) - before, 1)
            self.assertEqual(self.read("http-once", 0)[0], 425)
            status, _, body = self.start("http-once", "translate", {"text": "changed"})
            self.assertEqual((status, json.loads(body)["error"]), (409, "ipc_id_conflict"))
        finally:
            self.app.release.set()
        wire = self.read_wire("http-once")
        self.assertEqual(self.start("http-once", "translate", payload)[0], 200)
        self.assertEqual(self.read_wire("http-once"), wire)
        self.assertEqual(len(self.app.calls) - before, 1)
        for nonce in ("read-repeat-1", "read-repeat-2"):
            _, _, body = self.read("http-once", 0, nonce=nonce)
            self.assertEqual(png_size(body), (wire[0] + 1, wire[1] + 1))

    def test_http_bad_parameters_limits_and_missing(self):
        bad = [
            ("/ipc/start.png?id=x&op=unknown&d=%7B%7D", "ipc_bad_op"),
            ("/ipc/start.png?id=x&op=test&d=[]", "ipc_bad_json"),
            ("/ipc/start.png?id=x&op=test&d={bad}", "ipc_bad_json"),
            ("/ipc/start.png?id=x&op=test&d=%7B%22n%22:NaN%7D", "ipc_bad_json"),
            ("/ipc/start.png?id=x&op=test&d=%7B%22n%22:Infinity%7D", "ipc_bad_json"),
            ("/ipc/start.png?id=x&id=y&op=test&d=%7B%7D", "ipc_bad_query"),
            ("/ipc/start.png?id=&op=test&d=%7B%7D", "ipc_bad_query"),
            ("/ipc/start.png?id=" + "a" * 97 + "&op=test&d=%7B%7D", "ipc_bad_id"),
            ("/ipc/start.png?id=%E4%BD%A0&op=test&d=%7B%7D", "ipc_bad_id"),
            ("/ipc/start.png?id=%FF&op=test&d=%7B%7D", "ipc_bad_query"),
            ("/ipc/read.png?id=x&part=-1", "ipc_bad_part"),
            ("/ipc/read.png?id=x&part=0.0", "ipc_bad_part"),
            ("/ipc/read.png?id=x&part=" + str(MAX_PARTS), "ipc_bad_part"),
            ("/ipc/read.png?id=x&part=0&part=1", "ipc_bad_query"),
            ("/ipc/read.png?id=x&part=0&nonce=%0A", "ipc_bad_id"),
            ("/ipc/probe.png?" + "&".join("x=1" for _ in range(9)), "ipc_bad_query"),
            ("/ipc/probe.png?q=" + "a" * (64 * 1024 - 1024), "ipc_query_too_large"),
        ]
        for path, error in bad:
            with self.subTest(path=path[:100]):
                status, _, body = self.request(path)
                self.assertEqual((status, json.loads(body)["error"]), (400, error))
        status, _, body = self.read("http-does-not-exist", 0)
        self.assertEqual((status, json.loads(body)["error"]), (404, "ipc_missing"))
        self.assertEqual(self.request("/ipc/unknown.png")[0], 404)
        self.assertEqual(self.request("/ipc/start.png", payload={})[0], 405)

    def test_ipc_payload_and_parts_are_absent_from_access_logs(self):
        marker = "private-chat-and-key-image-route"
        with self.assertLogs("dlchat.bridge.image_ipc", level="INFO") as logs:
            self.assertEqual(self.start("private", "settings", {"api_key": marker})[0], 200)
            self.read_wire("private")
            wait_until(lambda: any("id=private" in line for line in logs.output))
        self.assertNotIn(marker, "\n".join(logs.output))
        path = self.app.access_log_path
        access = path.read_text(encoding="utf-8") if path.exists() else ""
        self.assertNotIn(marker, access)
        self.assertNotIn("/ipc/", access)

    def test_shared_api_exception_is_a_safe_job_result(self):
        with self.assertLogs("dlchat.bridge.server", level="ERROR") as logs:
            self.assertEqual(self.start("http-exception", "translate", {"text": "exception"})[0], 200)
            result = decode_frame(self.read_wire("http-exception"))["result"]
        self.assertEqual(result, {"ok": False, "error": "internal_error"})
        self.assertNotIn("exception-with-secret-content", "\n".join(logs.output))


if __name__ == "__main__":
    unittest.main()
