#!/usr/bin/env python3
"""Static server for VR Clay.

  python serve.py                 serve on http://localhost:8080
  python serve.py --port 9000     pick a port
  python serve.py --vendor        download three.js into ./vendor first (offline use)
  python serve.py --https         serve over TLS using cert.pem / key.pem in this folder

WebXR needs a secure context. http://localhost counts as secure, so the easiest
route to a Quest is `adb reverse tcp:8080 tcp:8080` and then opening
http://localhost:8080 in the headset browser. See README.md.
"""

import argparse
import http.server
import json
import os
import re
import socket
import socketserver
import ssl
import sys
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
THREE_URL = "https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js"
VENDOR_PATH = os.path.join(ROOT, "vendor", "three.module.js")
EXPORT_DIR = os.path.join(ROOT, "exports")
LIBRARY_DIR = os.path.join(ROOT, "library")

# Saved sculpts live here as .clay files. Any device on the network can list,
# load, overwrite and delete them, which is what makes "sculpt in the headset,
# carry on at the desk" work.
SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

# A sculpt made in the headset can be posted here so the file lands on the PC
# instead of in the headset's own downloads. Deliberately narrow: only these
# extensions, only plain names, only into exports/, and only up to the cap.
ALLOWED_EXPORT_EXT = (".glb", ".ply", ".obj", ".stl")
MAX_UPLOAD_BYTES = 96 * 1024 * 1024
SAFE_NAME = re.compile(r"^[A-Za-z0-9._-]{1,120}$")


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".json": "application/json",
        ".wasm": "application/wasm",
    }
    allow_upload = True

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    # ------------------------------------------------------------- library

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/sculpts":
            self._list_sculpts()
        elif path.startswith("/api/sculpts/"):
            self._read_sculpt(path[len("/api/sculpts/"):])
        else:
            super().do_GET()

    def do_PUT(self):
        path = urllib.parse.urlparse(self.path).path
        if path.startswith("/api/sculpts/"):
            self._write_sculpt(path[len("/api/sculpts/"):])
        else:
            self.send_error(404, "Not found")

    def do_DELETE(self):
        path = urllib.parse.urlparse(self.path).path
        if path.startswith("/api/sculpts/"):
            self._delete_sculpt(path[len("/api/sculpts/"):])
        else:
            self.send_error(404, "Not found")

    def _sculpt_path(self, raw):
        sculpt_id = os.path.basename(urllib.parse.unquote(raw))
        if not SAFE_ID.match(sculpt_id):
            return None, None
        return sculpt_id, os.path.join(LIBRARY_DIR, sculpt_id + ".clay")

    def _list_sculpts(self):
        items = []
        if os.path.isdir(LIBRARY_DIR):
            for name in os.listdir(LIBRARY_DIR):
                if not name.endswith(".clay"):
                    continue
                full = os.path.join(LIBRARY_DIR, name)
                try:
                    with open(full, "rb") as handle:
                        head = handle.read(8192)
                    if head[:8] != b"VRCLAY01":
                        continue
                    meta_len = int.from_bytes(head[8:12], "little")
                    # header is padded to a 4-byte boundary; tolerate either
                    # space or NUL padding inside the declared length
                    raw = head[12:12 + meta_len].rstrip(b"\x00 \t\r\n")
                    meta = json.loads(raw.decode("utf-8"))
                except (OSError, ValueError, UnicodeDecodeError):
                    continue
                meta["id"] = name[:-5]
                meta["bytes"] = os.path.getsize(full)
                meta["modified"] = int(os.path.getmtime(full) * 1000)
                items.append(meta)
        items.sort(key=lambda m: m.get("modified", 0), reverse=True)
        self._send_json(items)

    def _read_sculpt(self, raw):
        sculpt_id, path = self._sculpt_path(raw)
        if not sculpt_id:
            self.send_error(400, "Bad id")
            return
        if not os.path.exists(path):
            self.send_error(404, "No such sculpt")
            return
        with open(path, "rb") as handle:
            data = handle.read()
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _write_sculpt(self, raw):
        if not self.allow_upload:
            self.send_error(403, "Saving disabled (--no-upload)")
            return
        sculpt_id, path = self._sculpt_path(raw)
        if not sculpt_id:
            self.send_error(400, "Bad id")
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            self.send_error(411, "Length required")
            return
        if length <= 0 or length > MAX_UPLOAD_BYTES:
            self.send_error(413, "Bad length")
            return

        os.makedirs(LIBRARY_DIR, exist_ok=True)
        # Write to a temp file and replace, so an interrupted save can't destroy
        # the sculpt that was already there.
        temp = path + ".part"
        remaining = length
        with open(temp, "wb") as handle:
            while remaining > 0:
                chunk = self.rfile.read(min(1 << 20, remaining))
                if not chunk:
                    break
                handle.write(chunk)
                remaining -= len(chunk)
        if remaining > 0:
            os.remove(temp)
            self.send_error(400, "Truncated upload")
            return
        os.replace(temp, path)
        sys.stderr.write("  saved sculpt %s (%d bytes)\n" % (sculpt_id, length))
        self._send_json({"ok": True, "id": sculpt_id, "bytes": length})

    def _delete_sculpt(self, raw):
        if not self.allow_upload:
            self.send_error(403, "Saving disabled (--no-upload)")
            return
        sculpt_id, path = self._sculpt_path(raw)
        if not sculpt_id:
            self.send_error(400, "Bad id")
            return
        if os.path.exists(path):
            os.remove(path)
        self._send_json({"ok": True, "id": sculpt_id})

    def _send_json(self, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    # -------------------------------------------------------------- exports

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if not path.startswith("/export/"):
            self.send_error(404, "Not found")
            return
        if not self.allow_upload:
            self.send_error(403, "Uploads disabled (--no-upload)")
            return

        name = urllib.parse.unquote(path[len("/export/"):])
        name = os.path.basename(name)
        if not SAFE_NAME.match(name) or not name.lower().endswith(ALLOWED_EXPORT_EXT):
            self.send_error(400, "Bad filename")
            return

        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            self.send_error(411, "Length required")
            return
        if length <= 0 or length > MAX_UPLOAD_BYTES:
            self.send_error(413, "Bad length")
            return

        os.makedirs(EXPORT_DIR, exist_ok=True)
        target = os.path.join(EXPORT_DIR, name)
        # basename + the name pattern already exclude separators; verify anyway
        if os.path.dirname(os.path.abspath(target)) != os.path.abspath(EXPORT_DIR):
            self.send_error(400, "Bad path")
            return

        remaining = length
        with open(target, "wb") as handle:
            while remaining > 0:
                chunk = self.rfile.read(min(1 << 20, remaining))
                if not chunk:
                    break
                handle.write(chunk)
                remaining -= len(chunk)

        body = json.dumps({"ok": True, "path": target, "bytes": length - remaining}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        sys.stderr.write("  saved %s\n" % target)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        # Keep the client address and time: when something "isn't loading",
        # the first question is whether the request arrived at all.
        sys.stderr.write("  %s  %s  %s\n" % (
            self.log_date_time_string(), self.address_string(), fmt % args))


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def vendor_three():
    os.makedirs(os.path.dirname(VENDOR_PATH), exist_ok=True)
    print("Downloading %s" % THREE_URL)
    with urllib.request.urlopen(THREE_URL, timeout=60) as response:
        data = response.read()
    with open(VENDOR_PATH, "wb") as handle:
        handle.write(data)
    print("Saved %s (%.1f KB) — the app now runs offline." % (VENDOR_PATH, len(data) / 1024))


def lan_ip():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        return sock.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        sock.close()


def main():
    parser = argparse.ArgumentParser(description="Serve VR Clay.")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--vendor", action="store_true", help="download three.js locally, then serve")
    parser.add_argument("--https", action="store_true", help="serve over TLS with cert.pem / key.pem")
    parser.add_argument("--no-upload", action="store_true",
                        help="refuse sculpt uploads from the headset to ./exports")
    args = parser.parse_args()

    if args.vendor:
        vendor_three()

    Handler.allow_upload = not args.no_upload
    scheme = "https" if args.https else "http"
    server = Server((args.host, args.port), Handler)

    if args.https:
        cert = os.path.join(ROOT, "cert.pem")
        key = os.path.join(ROOT, "key.pem")
        if not (os.path.exists(cert) and os.path.exists(key)):
            sys.exit(
                "Missing cert.pem / key.pem. Create them with:\n"
                "  openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem "
                "-out cert.pem -days 365 -subj \"/CN=vrclay\"\n"
                "Or skip TLS and use: adb reverse tcp:%d tcp:%d" % (args.port, args.port)
            )
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cert, key)
        server.socket = context.wrap_socket(server.socket, server_side=True)

    print("\n  VR Clay")
    print("  local    %s://localhost:%d" % (scheme, args.port))
    print("  network  %s://%s:%d" % (scheme, lan_ip(), args.port))
    if Handler.allow_upload:
        print("  exports  %s  (Send to PC writes here)" % EXPORT_DIR)
        print("  library  %s  (saved sculpts)" % LIBRARY_DIR)
    else:
        print("  exports  disabled (--no-upload)")
    if not args.https:
        print("\n  Headset over USB:  adb reverse tcp:%d tcp:%d" % (args.port, args.port))
        print("  then open          http://localhost:%d in the headset browser" % args.port)
    print("\n  Ctrl+C to stop\n")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  stopped")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
