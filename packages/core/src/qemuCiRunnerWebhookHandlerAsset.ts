export const QEMU_CI_WEBHOOK_HANDLER = `class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/workflow-job" or not hmac.compare_digest(
            self.headers.get("Authorization", ""), authorization
        ):
            self.send_error(404)
            return
        if self.headers.get("X-Gitea-Event") != "workflow_job":
            self.send_error(400)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 1 or length > 1048576:
                raise ValueError("invalid payload size")
            payload = json.loads(self.rfile.read(length))
            workflow_job = payload["workflow_job"]
            job_id = int(workflow_job["id"])
            action = payload.get("action")
            selected = not dispatch_labels.isdisjoint(workflow_job.get("labels", []))
        except (KeyError, TypeError, ValueError, json.JSONDecodeError):
            self.send_error(400)
            return
        if selected and action in ("queued", "in_progress", "completed"):
            def record_event(state):
                if action == "queued":
                    if job_id in state["completed"] or job_id in state["running"]:
                        return
                    state["queued"].add(job_id)
                elif action == "in_progress":
                    if job_id in state["completed"]:
                        return
                    state["queued"].discard(job_id)
                    state["running"].add(job_id)
                else:
                    state["queued"].discard(job_id)
                    state["running"].discard(job_id)
                    state["claims"].pop(job_id, None)
                    state["completed"].setdefault(job_id, time.time())
            try:
                locked_update(record_event)
            except (OSError, UnicodeError, StateSchemaError, json.JSONDecodeError) as error:
                print(f"qemu-ci-scheduler: state update failed: {error}", flush=True)
                self.send_error(500, "scheduler state unavailable")
                return
            print(f"qemu-ci-scheduler: {action} job {job_id}", flush=True)
        self.send_response(202)
        self.end_headers()

    def log_message(self, format, *args):
        print("qemu-ci-webhook:", format % args, flush=True)

`;
