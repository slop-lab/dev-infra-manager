#!/usr/bin/env python3
from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Final
import hmac
import json
import signal
import sys
import threading

from protocol import HostId, ProjectId, ProtocolError, exact_object, identifier, load_config, positive_integer, string_array, text
from store import SchedulerStore

MAX_BODY: Final = 65_536


class SchedulerServer(ThreadingHTTPServer):
    daemon_threads = False

    def __init__(self, config_path: Path) -> None:
        self.config = load_config(config_path)
        self.store = SchedulerStore(self.config.database, self.config.lease_seconds)
        super().__init__((self.config.host, self.config.port), Handler)


class Handler(BaseHTTPRequestHandler):
    server: SchedulerServer

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(10)

    def do_GET(self) -> None:
        if self.path != "/healthz":
            self.send_error(404)
            return
        self.send_response(200)
        self.end_headers()

    def do_POST(self) -> None:
        try:
            body = self._body()
            if self.path == "/v1/events":
                self._event(body)
                return
            webhook_parts = self.path.split("/")
            if len(webhook_parts) == 5 and webhook_parts[:3] == ["", "v1", "webhooks"] and webhook_parts[4:] == ["workflow-job"]:
                self._webhook(ProjectId(identifier(webhook_parts[3], "project ID")), body)
                return
            if self.path == "/v1/claims":
                self._claim(body)
                return
            parts = self.path.split("/")
            if len(parts) == 5 and parts[:3] == ["", "v1", "claims"] and parts[4] in {"renew", "release"}:
                self._lease(parts[3], parts[4], body)
                return
            self.send_error(404)
        except (ProtocolError, json.JSONDecodeError, UnicodeDecodeError):
            self.send_error(400)

    def _body(self) -> dict[str, object]:
        content_type = self.headers.get("Content-Type", "").split(";", 1)[0]
        if content_type != "application/json":
            raise ProtocolError("content type must be JSON")
        length_text = self.headers.get("Content-Length", "")
        if not length_text.isdigit():
            raise ProtocolError("content length is required")
        length = int(length_text)
        if length < 2 or length > MAX_BODY:
            raise ProtocolError("invalid body length")
        return self._json_object(length)

    def _json_object(self, length: int) -> dict[str, object]:
        value = json.loads(self.rfile.read(length).decode("utf-8"))
        if type(value) is not dict:
            raise ProtocolError("request must be an object")
        return value

    def _event(self, body: dict[str, object]) -> None:
        request = exact_object(body, {"projectId", "action", "jobId", "labels"}, "event")
        project_id = ProjectId(identifier(request["projectId"], "project ID"))
        project = self.server.config.projects.get(project_id)
        authorization = self.headers.get("Authorization", "")
        host_id = self.headers.get("X-DIM-Host")
        host_token = None if project is None or host_id is None else project.hosts.get(HostId(host_id))
        if host_token is None or not hmac.compare_digest(authorization, f"Bearer {host_token}"):
            self.send_error(404)
            return
        action = text(request["action"], "action")
        if action != "queued":
            raise ProtocolError("host events may only seed queued demand")
        job_id = positive_integer(request["jobId"], "job ID", maximum=9_007_199_254_740_991)
        labels = string_array(request["labels"], "labels")
        if not set(labels).issubset(project.allowed_labels):
            raise ProtocolError("event labels are not allowed for this project")
        self.server.store.record_event(project_id, action, job_id, labels)
        self.send_response(202)
        self.end_headers()

    def _webhook(self, project_id: ProjectId, body: dict[str, object]) -> None:
        project = self.server.config.projects.get(project_id)
        authorization = self.headers.get("Authorization", "")
        if project is None or self.headers.get("X-Gitea-Event") != "workflow_job" or not hmac.compare_digest(authorization, f"Bearer {project.webhook_token}"):
            self.send_error(404)
            return
        action_value = body.get("action")
        workflow_job_value = body.get("workflow_job")
        if type(workflow_job_value) is not dict:
            raise ProtocolError("workflow_job must be an object")
        action = text(action_value, "action")
        if action not in {"queued", "in_progress", "completed"}:
            raise ProtocolError("invalid action")
        job_id = positive_integer(workflow_job_value.get("id"), "job ID", maximum=9_007_199_254_740_991)
        labels = string_array(workflow_job_value.get("labels"), "labels")
        self.server.store.record_event(project_id, action, job_id, labels)
        self.send_response(202)
        self.end_headers()

    def _host(self, body: dict[str, object], fields: set[str]) -> tuple[dict[str, object], ProjectId, HostId]:
        request = exact_object(body, fields | {"projectId", "hostId"}, "request")
        project_id = ProjectId(identifier(request["projectId"], "project ID"))
        host_id = HostId(identifier(request["hostId"], "host ID"))
        project = self.server.config.projects.get(project_id)
        token = None if project is None else project.hosts.get(host_id)
        authorization = self.headers.get("Authorization", "")
        if token is None or self.headers.get("X-DIM-Host") != host_id or not hmac.compare_digest(authorization, f"Bearer {token}"):
            self.send_error(404)
            raise PermissionError
        return request, project_id, host_id

    def _claim(self, body: dict[str, object]) -> None:
        try:
            request, project_id, host_id = self._host(body, {"capacity", "labels", "requestId"})
        except PermissionError:
            return
        lease = self.server.store.claim(
            project_id,
            host_id,
            identifier(request["capacity"], "capacity"),
            self._allowed_labels(project_id, request["labels"]),
            identifier(request["requestId"], "request ID"),
        )
        if lease is None:
            self.send_response(204)
            self.end_headers()
            return
        self._json(200, {"jobId": lease.job_id, "claimId": lease.claim_id, "leaseExpiresAt": lease.expires_at, "leaseSeconds": lease.lease_seconds})

    def _allowed_labels(self, project_id: ProjectId, value: object) -> tuple[str, ...]:
        labels = string_array(value, "labels")
        project = self.server.config.projects[project_id]
        if not set(labels).issubset(project.allowed_labels):
            raise ProtocolError("claim labels are not allowed for this project")
        return labels

    def _lease(self, claim_id_raw: str, operation: str, body: dict[str, object]) -> None:
        try:
            _request, project_id, host_id = self._host(body, set())
        except PermissionError:
            return
        claim_id = identifier(claim_id_raw, "claim ID")
        if operation == "renew":
            state = self.server.store.renew(project_id, host_id, claim_id)
            if state == "lost":
                self.send_error(409)
                return
            body: dict[str, str | int | float] = {"state": state}
            if state == "renewed":
                body["leaseSeconds"] = self.server.config.lease_seconds
            self._json(200, body)
            return
        if not self.server.store.release(project_id, host_id, claim_id):
            self.send_error(409)
            return
        self.send_response(204)
        self.end_headers()

    def _json(self, status: int, body: dict[str, str | int | float]) -> None:
        encoded = json.dumps(body, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, format: str, *args: object) -> None:
        print(f"shared-qemu-scheduler: {self.address_string()} {format % args}", flush=True)


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: server.py CONFIG")
    server = SchedulerServer(Path(sys.argv[1]))
    signal.signal(signal.SIGTERM, lambda _signal, _frame: threading.Thread(target=server.shutdown).start())
    signal.signal(signal.SIGINT, lambda _signal, _frame: threading.Thread(target=server.shutdown).start())
    server.serve_forever(poll_interval=0.1)
    server.server_close()


if __name__ == "__main__":
    main()
