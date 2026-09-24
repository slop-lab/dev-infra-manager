export const QEMU_CI_SHARED_WORKER = `class SchedulerProtocolError(RuntimeError):
    pass

class SchedulerNoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        return None

scheduler_opener = urllib.request.build_opener(SchedulerNoRedirect)
scheduler_max_response_bytes = 65536

def scheduler_request(path, payload):
    encoded = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(
        scheduler_endpoint + path,
        data=encoded,
        method="POST",
        headers={
            "Authorization": "Bearer " + scheduler_token,
            "Content-Type": "application/json",
            "X-DIM-Host": scheduler_host_id,
        },
    )
    with scheduler_opener.open(request, timeout=2) as response:
        if response.status == 204:
            return None
        if response.headers.get_content_type() != "application/json":
            raise SchedulerProtocolError("shared scheduler response must be JSON")
        encoded = response.read(scheduler_max_response_bytes + 1)
        if len(encoded) > scheduler_max_response_bytes:
            raise SchedulerProtocolError("shared scheduler response is too large")
        value = json.loads(encoded)
        if type(value) is not dict:
            raise SchedulerProtocolError("shared scheduler response must be an object")
        return value

def scheduler_exact_response(value, fields, name):
    if type(value) is not dict or set(value) != fields:
        raise SchedulerProtocolError(f"invalid shared scheduler {name} response")
    return value

def scheduler_claim(payload):
    value = scheduler_request("/v1/claims", payload)
    if value is None:
        return None
    response = scheduler_exact_response(value, {"jobId", "claimId", "leaseExpiresAt", "leaseSeconds"}, "claim")
    if type(response["jobId"]) is not int or response["jobId"] < 1:
        raise SchedulerProtocolError("invalid shared scheduler claim jobId")
    if type(response["claimId"]) is not str or not response["claimId"]:
        raise SchedulerProtocolError("invalid shared scheduler claim claimId")
    if type(response["leaseExpiresAt"]) not in {int, float}:
        raise SchedulerProtocolError("invalid shared scheduler claim leaseExpiresAt")
    if type(response["leaseSeconds"]) is not int or response["leaseSeconds"] < 60:
        raise SchedulerProtocolError("invalid shared scheduler claim leaseSeconds")
    return response

def scheduler_renew(claim_id, payload):
    try:
        value = scheduler_request(f"/v1/claims/{claim_id}/renew", payload)
    except urllib.error.HTTPError as error:
        if error.code == 409:
            return "lost", None
        raise
    if value is None or type(value.get("state")) is not str:
        raise SchedulerProtocolError("invalid shared scheduler renew response")
    state = value["state"]
    if state == "detached" and set(value) == {"state"}:
        return state, None
    if state == "renewed" and set(value) == {"state", "leaseSeconds"} and type(value["leaseSeconds"]) is int and value["leaseSeconds"] >= 60:
        return state, value["leaseSeconds"]
    raise SchedulerProtocolError("invalid shared scheduler renew state")

def scheduler_release(claim_id, payload):
    try:
        value = scheduler_request(f"/v1/claims/{claim_id}/release", payload)
    except urllib.error.HTTPError as error:
        if error.code == 409:
            return
        raise
    if value is not None:
        raise SchedulerProtocolError("invalid shared scheduler release response")

def shared_worker():
    failures = 0
    request_id = secrets.token_urlsafe(24)
    while not shutdown.is_set():
        try:
            claim_started = time.monotonic()
            lease = scheduler_claim({
                "projectId": scheduler_project_id,
                "hostId": scheduler_host_id,
                "capacity": capacity,
                "labels": sorted(dispatch_labels),
                "requestId": request_id,
            })
            shared_scheduler_ready.set()
            request_id = secrets.token_urlsafe(24)
        except (OSError, TimeoutError, json.JSONDecodeError, SchedulerProtocolError) as error:
            failures += 1
            delay = min(2 ** max(failures, 1), 30)
            print(f"qemu-ci-scheduler: shared claim failed: {error}; retrying in {delay}s", flush=True)
            if shutdown.wait(delay):
                break
            continue
        if lease is None:
            shutdown.wait(1)
            continue
        trigger_job_id = lease["jobId"]
        claim_id = lease["claimId"]
        lease_deadline = claim_started + lease["leaseSeconds"]
        print(f"qemu-ci-scheduler: capacity {capacity} claimed shared trigger job {trigger_job_id}", flush=True)
        process = None
        try:
            child_environment = {
                key: value for key, value in os.environ.items()
                if not key.startswith("DIM_QEMU_SCHEDULER_") and key != "DIM_QEMU_WEBHOOK_AUTHORIZATION"
            }
            process = subprocess.Popen(
                ["bash", "/usr/local/bin/dim-qemu-ci-supervise"],
                start_new_session=True,
                env=child_environment,
            )
            renewing = True
            while process.poll() is None:
                if not renewing:
                    if shutdown.wait(heartbeat_seconds):
                        break
                    continue
                remaining = lease_deadline - time.monotonic()
                if remaining <= 0:
                    raise RuntimeError("shared scheduler lease deadline elapsed")
                if shutdown.wait(min(heartbeat_seconds, remaining)):
                    break
                renewal_started = time.monotonic()
                state, renewed_seconds = scheduler_renew(claim_id, {
                    "projectId": scheduler_project_id,
                    "hostId": scheduler_host_id,
                })
                if state == "detached":
                    renewing = False
                elif state == "lost":
                    raise RuntimeError("shared scheduler lease ownership was lost")
                else:
                    lease_deadline = renewal_started + renewed_seconds
            if process.poll() is not None and process.returncode != 0:
                raise subprocess.CalledProcessError(process.returncode, process.args)
            if process.poll() is not None:
                failures = 0
        except (OSError, TimeoutError, json.JSONDecodeError, SchedulerProtocolError, RuntimeError, subprocess.CalledProcessError) as error:
            failures += 1
            print(f"qemu-ci-scheduler: shared supervisor failed: {error}", flush=True)
        finally:
            if process is not None:
                terminate_supervisor(process)
        while True:
            try:
                scheduler_release(claim_id, {
                    "projectId": scheduler_project_id,
                    "hostId": scheduler_host_id,
                })
                break
            except (OSError, TimeoutError, json.JSONDecodeError, SchedulerProtocolError) as error:
                failures += 1
                delay = min(2 ** max(failures, 1), 30)
                print(f"qemu-ci-scheduler: shared claim release failed: {error}; retrying in {delay}s", flush=True)
                if shutdown.wait(delay):
                    break

`;
