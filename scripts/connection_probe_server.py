"""Local-only HTTP/HTTPS probes for Deadlock Panorama navigation diagnostics.

Run with a certificate already saved on disk (this script never changes trust):
    python scripts/connection_probe_server.py --cert CERT.pem --key KEY.pem

HTTP listens on loopback port 8793, HTTPS on loopback port 8792. Both IPv4
and IPv6 are tried. Results are appended to --log and available at /summary.
Run --self-test for offline PNG/route checks without opening any listeners.
"""

from __future__ import annotations

import argparse
import base64
from collections import Counter
from datetime import datetime, timezone
import html
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import socket
import ssl
import struct
import sys
import threading
from urllib.parse import parse_qs, urlsplit
import zlib


DEFAULT_LOG = (
    Path(__file__).resolve().parents[1]
    / "build" / ".work" / "connection-probe" / "events.jsonl"
)
MAX_QUERY_LENGTH = 8192
MAX_MARKER_LENGTH = 128
MAX_EVENT_FIELDS = 32
MAX_EVENT_VALUE_LENGTH = 512
BRIDGE_TITLE = 'LCTPROBE{"ok":true,"transport":"https-probe"}'
PIXEL_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNg"
    "AAIAAAUAAXpeqz8AAAAASUVORK5CYII="
)
BROKEN_PNG = b"\x89PNG\r\n\x1a\nTongyi deliberately invalid image probe"


def sized_png(width: int, height: int) -> bytes:
    """Generate a bounded transparent RGBA PNG using only the standard library."""
    if not (1 <= width <= 256 and 1 <= height <= 256):
        raise ValueError("Probe image dimensions must be between 1 and 256")

    def chunk(kind: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data)) + kind + data
            + struct.pack(">I", zlib.crc32(kind + data))
        )

    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    # One filter byte plus four zero-valued color channels for every row.
    pixels = bytes((width * 4 + 1) * height)
    return (
        b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(pixels)) + chunk(b"IEND", b"")
    )


def dimension(query: dict[str, list[str]], name: str) -> int:
    values = query.get(name, [])
    if len(values) != 1:
        raise ValueError("Expected exactly one dimension value")
    value = values[0]
    if not (value.isascii() and value.isdecimal() and len(value) <= 3):
        raise ValueError("Expected a decimal dimension")
    number = int(value)
    if not 1 <= number <= 256:
        raise ValueError("Probe dimensions must be between 1 and 256")
    return number


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def event_summary(value: object) -> object:
    """Keep diagnostic events small, including when nested data is supplied."""
    if isinstance(value, dict):
        result = {}
        for key, item in list(value.items())[:MAX_EVENT_FIELDS]:
            key = str(key)[:80]
            if isinstance(item, (str, int, float, bool)) or item is None:
                result[key] = item[:MAX_EVENT_VALUE_LENGTH] if isinstance(item, str) else item
            else:
                result[key] = json.dumps(item, ensure_ascii=True)[:MAX_EVENT_VALUE_LENGTH]
        if len(value) > MAX_EVENT_FIELDS:
            result["_truncated_fields"] = len(value) - MAX_EVENT_FIELDS
        return result
    return str(value)[:MAX_EVENT_VALUE_LENGTH]


class ProbeState:
    def __init__(self, log_path: Path) -> None:
        self.log_path = log_path
        self.started_at = timestamp()
        self.lock = threading.Lock()
        self.counts: Counter[str] = Counter()
        self.scheme_counts = {"http": Counter(), "https": Counter()}
        self.recent: list[dict] = []
        self.listeners: list[str] = []
        log_path.parent.mkdir(parents=True, exist_ok=True)

    def record(self, kind: str, **fields: object) -> None:
        item = {"time": timestamp(), "kind": kind, **fields}
        with self.lock:
            self.counts[kind] += 1
            scheme = fields.get("scheme")
            if scheme in self.scheme_counts:
                self.scheme_counts[scheme][kind] += 1
            self.recent.append(item)
            self.recent = self.recent[-40:]
            with self.log_path.open("a", encoding="utf-8") as log_file:
                log_file.write(json.dumps(item, ensure_ascii=True) + "\n")

    def summary(self) -> dict:
        with self.lock:
            return {
                "started_at": self.started_at,
                "log": str(self.log_path),
                "listeners": list(self.listeners),
                "counts": {
                    key: self.counts[key]
                    for key in ["ping", "image", "event", "bridge", "tls_success", "tls_failure"]
                },
                "by_scheme": {key: dict(value) for key, value in self.scheme_counts.items()},
                "recent": list(self.recent),
            }


class ProbeServer(ThreadingHTTPServer):
    daemon_threads = True
    block_on_close = False
    allow_reuse_address = True

    def __init__(
        self,
        address: tuple[str, int],
        state: ProbeState,
        timeout: float,
        tls_context: ssl.SSLContext | None = None,
    ) -> None:
        self.state = state
        self.request_timeout = timeout
        self.tls_context = tls_context
        self.scheme = "https" if tls_context else "http"
        super().__init__(address, ProbeHandler)

    def get_request(self) -> tuple[socket.socket, tuple]:
        connection, peer = super().get_request()
        connection.settimeout(self.request_timeout)
        if self.tls_context is None:
            return connection, peer
        secure_connection = None
        try:
            secure_connection = self.tls_context.wrap_socket(
                connection, server_side=True, do_handshake_on_connect=False,
            )
            secure_connection.do_handshake()
            self.state.record(
                "tls_success", scheme=self.scheme, peer=peer[0],
                version=secure_connection.version(),
            )
            return secure_connection, peer
        except (OSError, ValueError) as error:
            self.state.record(
                "tls_failure", scheme=self.scheme, peer=peer[0],
                error_type=type(error).__name__,
                reason=str(getattr(error, "reason", "")),
                detail=str(error)[:512],
            )
            if secure_connection is not None:
                secure_connection.close()
            connection.close()
            # BaseServer catches OSError from get_request and keeps listening.
            raise OSError("TLS probe handshake failed") from error

    def handle_error(self, request: socket.socket, client_address: tuple) -> None:
        self.state.record("request_error", scheme=self.scheme, peer=client_address[0])


class IPv6ProbeServer(ProbeServer):
    address_family = socket.AF_INET6

    def server_bind(self) -> None:
        self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
        super().server_bind()


class ProbeHandler(BaseHTTPRequestHandler):
    server_version = "TongyiConnectionProbe/1"
    sys_version = ""

    def log_message(self, format: str, *args: object) -> None:
        # Requests are logged structurally, without dumping raw query strings.
        pass

    def respond(self, status: int, data: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(data)
        self.close_connection = True

    def page(self, static_title: str, dynamic_title: str) -> bytes:
        # JSON's '<' is escaped so marker text cannot terminate a script tag.
        script_title = json.dumps(dynamic_title, ensure_ascii=True).replace("<", "\\u003c")
        body = (
            "<!doctype html><html><head><meta charset=\"utf-8\"><title>"
            + html.escape(static_title)
            + "</title></head><body>Local Panorama connection probe"
            + "<script>setTimeout(function(){document.title="
            + script_title
            + ";},100);</script></body></html>"
        )
        return body.encode("utf-8")

    def do_GET(self) -> None:
        if len(self.path) > MAX_QUERY_LENGTH + 256:
            self.respond(414, b"Probe query too long", "text/plain; charset=utf-8")
            return
        try:
            parsed = urlsplit(self.path)
            if len(parsed.query) > MAX_QUERY_LENGTH:
                self.respond(414, b"Probe query too long", "text/plain; charset=utf-8")
                return
            if parsed.scheme or parsed.netloc:
                raise ValueError("Expected a local path with a short query")
            query = parse_qs(parsed.query, keep_blank_values=True, max_num_fields=16)
        except ValueError:
            self.respond(400, b"Invalid probe query", "text/plain; charset=utf-8")
            return
        scheme = self.server.scheme
        common = {"scheme": scheme, "peer": self.client_address[0]}
        marker = query.get("m", [""])[0][:MAX_MARKER_LENGTH]
        if parsed.path == "/summary":
            data = json.dumps(self.server.state.summary(), ensure_ascii=True, indent=2).encode("utf-8")
            self.respond(200, data, "application/json; charset=utf-8")
        elif parsed.path == "/ping":
            self.server.state.record("ping", marker=marker, **common)
            payload = {"ok": True, "transport": scheme + "-probe", "marker": marker}
            static = "LCTPROBE" + json.dumps({**payload, "phase": "static"}, separators=(",", ":"))
            dynamic = "LCTPROBE" + json.dumps({**payload, "phase": "script"}, separators=(",", ":"))
            self.respond(200, self.page(static, dynamic), "text/html; charset=utf-8")
        elif parsed.path == "/bridge":
            self.server.state.record("bridge", marker=marker, **common)
            self.respond(200, self.page(BRIDGE_TITLE, BRIDGE_TITLE), "text/html; charset=utf-8")
        elif parsed.path == "/image.png":
            self.server.state.record(
                "image", marker=marker, width=1, height=1, variant="baseline", **common,
            )
            self.respond(200, PIXEL_PNG, "image/png")
        elif parsed.path == "/size.png":
            try:
                width = dimension(query, "w")
                height = dimension(query, "h")
            except ValueError:
                self.respond(400, b"Expected single w and h values between 1 and 256", "text/plain; charset=utf-8")
                return
            self.server.state.record(
                "image", marker=marker, width=width, height=height, variant="sized", **common,
            )
            self.respond(200, sized_png(width, height), "image/png")
        elif parsed.path == "/broken.png":
            self.server.state.record(
                "image", marker=marker, width=0, height=0, variant="broken", **common,
            )
            self.respond(200, BROKEN_PNG, "image/png")
        elif parsed.path == "/missing.png":
            self.server.state.record(
                "image", marker=marker, width=0, height=0, variant="missing", **common,
            )
            self.respond(404, b"Deliberately missing image probe", "text/plain; charset=utf-8")
        elif parsed.path == "/event.png":
            try:
                value = json.loads(query.get("d", [""])[0])
            except (ValueError, TypeError):
                self.respond(400, b"Expected JSON in d", "text/plain; charset=utf-8")
                return
            self.server.state.record("event", data=event_summary(value), **common)
            self.respond(200, PIXEL_PNG, "image/png")
        else:
            self.respond(404, b"Probe route not found", "text/plain; charset=utf-8")


def run_self_test() -> int:
    """Check image bytes, route boundaries and counters without binding a port."""
    import tempfile
    from types import SimpleNamespace

    class MemoryHandler(ProbeHandler):
        def __init__(self, path: str, state: ProbeState) -> None:
            self.path = path
            self.server = SimpleNamespace(scheme="http", state=state)
            self.client_address = ("127.0.0.1", 0)
            self.result = None

        def respond(self, status: int, data: bytes, content_type: str) -> None:
            self.result = (status, data, content_type)

    def read_png(data: bytes) -> tuple[int, int]:
        assert data.startswith(b"\x89PNG\r\n\x1a\n"), "Invalid PNG signature"
        offset = 8
        dimensions = None
        compressed = b""
        ended = False
        while offset < len(data):
            length = struct.unpack_from(">I", data, offset)[0]
            kind = data[offset + 4:offset + 8]
            body = data[offset + 8:offset + 8 + length]
            crc = struct.unpack_from(">I", data, offset + 8 + length)[0]
            assert zlib.crc32(kind + body) == crc, "Invalid PNG chunk CRC"
            if kind == b"IHDR":
                width, height, depth, color, compression, filtering, interlace = struct.unpack(">IIBBBBB", body)
                assert (depth, color, compression, filtering, interlace) == (8, 6, 0, 0, 0)
                dimensions = (width, height)
            elif kind == b"IDAT":
                compressed += body
            elif kind == b"IEND":
                ended = True
            offset += length + 12
        assert ended and offset == len(data) and dimensions is not None
        width, height = dimensions
        decoded = zlib.decompress(compressed)
        assert decoded == bytes((width * 4 + 1) * height), "Incorrect RGBA pixel data"
        return dimensions

    with tempfile.TemporaryDirectory(prefix="tongyi-probe-selftest-") as directory:
        state = ProbeState(Path(directory) / "events.jsonl")

        def request(path: str) -> tuple[int, bytes, str]:
            handler = MemoryHandler(path, state)
            handler.do_GET()
            assert handler.result is not None
            return handler.result

        assert read_png(PIXEL_PNG) == (1, 1)
        status, data, content_type = request("/image.png")
        assert status == 200 and data == PIXEL_PNG and content_type == "image/png"
        for width, height in [(17, 29), (1, 256), (256, 256)]:
            status, data, content_type = request(f"/size.png?w={width}&h={height}")
            assert status == 200 and content_type == "image/png"
            assert read_png(data) == (width, height)
        status, data, content_type = request("/broken.png")
        assert status == 200 and data == BROKEN_PNG and content_type == "image/png"
        try:
            read_png(data)
        except (AssertionError, struct.error, zlib.error):
            pass
        else:
            raise AssertionError("Broken route unexpectedly returned a valid PNG")
        assert request("/missing.png")[0] == 404
        for query in [
            "w=0&h=1", "w=257&h=1", "w=-1&h=1", "w=1.5&h=1",
            "w=1&h=0", "w=1&h=257", "w=1&w=2&h=1", "w=1",
            "w=&h=1", "w=%2B1&h=1", "w=1&h=1&h=2",
        ]:
            assert request("/size.png?" + query)[0] == 400, query
        assert request("/size.png?w=1&h=1&extra=" + "x" * MAX_QUERY_LENGTH)[0] == 414
        summary = json.loads(request("/summary")[1])
        assert summary["counts"]["image"] == 6, summary["counts"]
        variants = Counter(item.get("variant") for item in summary["recent"] if item["kind"] == "image")
        assert variants == {"baseline": 1, "sized": 3, "broken": 1, "missing": 1}, variants
        assert len(state.log_path.read_text(encoding="utf-8").splitlines()) == 6
    print("Connection probe self-test passed: PNG dimensions/CRC/pixels, bad images, query guards and summary counters.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cert", type=Path, help="HTTPS certificate PEM file")
    parser.add_argument("--key", type=Path, help="HTTPS private-key PEM file")
    parser.add_argument("--log", type=Path, default=DEFAULT_LOG, help=f"JSONL log (default: {DEFAULT_LOG})")
    parser.add_argument("--timeout", type=float, default=5.0, help="Request/TLS timeout in seconds (0.1 to 60)")
    parser.add_argument("--self-test", action="store_true", help="Run offline checks without starting listeners")
    args = parser.parse_args()
    if args.self_test:
        return run_self_test()
    if args.cert is None or args.key is None:
        parser.error("--cert and --key are required when starting the probe service")
    if not 0.1 <= args.timeout <= 60:
        parser.error("--timeout must be between 0.1 and 60 seconds")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    servers: list[ProbeServer] = []
    threads: list[threading.Thread] = []
    try:
        # This is a server context: client trust and verification stay untouched.
        tls_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls_context.minimum_version = ssl.TLSVersion.TLSv1_2
        tls_context.load_cert_chain(args.cert, args.key)
        state = ProbeState(args.log.resolve())
        for port, context in [(8793, None), (8792, tls_context)]:
            for address, server_type in [("127.0.0.1", ProbeServer), ("::1", IPv6ProbeServer)]:
                try:
                    server = server_type((address, port), state, args.timeout, context)
                except OSError as error:
                    if address == "127.0.0.1":
                        raise
                    state.record("listener_unavailable", address=address, port=port, detail=str(error)[:512])
                    print(f"IPv6 unavailable on port {port}: {error}", flush=True)
                    continue
                servers.append(server)
                host = "[::1]" if address == "::1" else address
                state.listeners.append(f"{server.scheme}://{host}:{port}")
        state.record("started", listeners=state.listeners)
        for server in servers:
            worker = threading.Thread(target=server.serve_forever, name=f"probe-{server.scheme}", daemon=True)
            worker.start()
            threads.append(worker)
        print("Listening: " + ", ".join(state.listeners), flush=True)
        print("Log: " + str(state.log_path), flush=True)
        print("Summary: http://127.0.0.1:8793/summary", flush=True)
        print("Ctrl+C stops all probe listeners.", flush=True)
        while all(worker.is_alive() for worker in threads):
            threads[0].join(timeout=0.5)
    except KeyboardInterrupt:
        print("Stopping connection probes.", flush=True)
    except (OSError, ValueError, ssl.SSLError) as error:
        print(f"Cannot start connection probes: {error}", file=sys.stderr)
        return 1
    finally:
        for server in servers:
            if threads:
                server.shutdown()
            server.server_close()
        for worker in threads:
            worker.join(timeout=1)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
