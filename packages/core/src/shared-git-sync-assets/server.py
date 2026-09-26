#!/usr/bin/env python3
from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Final
import hmac
import json
import socket
import sys
import threading

from git_sync import GitOperationError, RepositoryBusyError, fetch_repository, publish_repository
from protocol import JsonValue, ProtocolError, RepositoryNotFoundError, load_config, parse_repository_path, strict_json, validate_external_url

MAX_BODY: Final = 65_536
MAX_HANDLERS: Final = 16


class GitSyncServer(ThreadingHTTPServer):
    daemon_threads = False

    def __init__(self, config_path: Path) -> None:
        self.config = load_config(config_path)
        self._slots = threading.BoundedSemaphore(MAX_HANDLERS)
        super().__init__((self.config.host, self.config.port), Handler)

    def process_request(self, request: socket.socket, client_address: tuple[str, int]) -> None:
        if not self._slots.acquire(blocking=False):
            request.sendall(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            self.shutdown_request(request)
            return
        request.settimeout(self.config.timeout_seconds)
        try:
            super().process_request(request, client_address)
        except RuntimeError:
            self._slots.release()
            raise

    def process_request_thread(self, request: socket.socket, client_address: tuple[str, int]) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._slots.release()


class Handler(BaseHTTPRequestHandler):
    server: GitSyncServer

    def do_GET(self) -> None:
        self.send_response(200 if self.path == "/healthz" else 404)
        self.end_headers()

    def do_POST(self) -> None:
        try:
            if not hmac.compare_digest(self.headers.get("Authorization", ""), f"Bearer {self.server.config.api_token}"):
                self.send_error(404)
                return
            project_id, alias, operation = parse_repository_path(self.path)
            repository = self.server.config.repositories.get((project_id, alias))
            if repository is None:
                self.send_error(404)
                return
            request = self._body()
            request["externalUrl"] = validate_external_url(request.get("externalUrl"), self.server.config.transport_policy)
            if operation == "fetch":
                fetch_repository(self.server.config, repository, request)
            else:
                publish_repository(self.server.config, repository, request)
            self.send_response(204)
            self.end_headers()
        except (ProtocolError, json.JSONDecodeError, UnicodeDecodeError):
            self.send_error(400)
        except RepositoryNotFoundError:
            self.send_error(404)
        except (RepositoryBusyError, GitOperationError):
            self.send_error(409)

    def _body(self) -> dict[str, JsonValue]:
        if self.headers.get("Content-Type", "").split(";", 1)[0] != "application/json":
            raise ProtocolError("content type must be JSON")
        length = self.headers.get("Content-Length", "")
        if not length.isdigit() or int(length) < 2 or int(length) > MAX_BODY:
            raise ProtocolError("invalid body length")
        value = strict_json(self.rfile.read(int(length)).decode("utf-8"))
        if type(value) is not dict:
            raise ProtocolError("request must be an object")
        return value

    def log_message(self, _format: str, *_args: str | int | float | None) -> None:
        return


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: server.py CONFIG")
    server = GitSyncServer(Path(sys.argv[1]))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        return
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
