export const QEMU_CI_SHARED_WORKER = `def scheduler_request(path, payload):
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
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            if response.status == 204:
                return None
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        if error.code == 409:
            return {"state": "lost"}
        raise

def shared_worker():
    failures = 0
    request_id = secrets.token_urlsafe(24)
    while not shutdown.is_set():
        try:
            lease = scheduler_request("/v1/claims", {
                "projectId": scheduler_project_id,
                "hostId": scheduler_host_id,
                "capacity": capacity,
                "labels": sorted(dispatch_labels),
                "requestId": request_id,
            })
            request_id = secrets.token_urlsafe(24)
        except (OSError, TimeoutError, json.JSONDecodeError) as error:
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
                if shutdown.wait(heartbeat_seconds):
                    break
                if not renewing:
                    continue
                renewal = scheduler_request(f"/v1/claims/{claim_id}/renew", {
                    "projectId": scheduler_project_id,
                    "hostId": scheduler_host_id,
                })
                state = renewal["state"]
                if state == "detached":
                    renewing = False
                elif state == "lost":
                    raise RuntimeError("shared scheduler lease ownership was lost")
            if process.poll() is not None and process.returncode != 0:
                raise subprocess.CalledProcessError(process.returncode, process.args)
            if process.poll() is not None:
                failures = 0
        except (OSError, TimeoutError, json.JSONDecodeError, RuntimeError, subprocess.CalledProcessError) as error:
            failures += 1
            print(f"qemu-ci-scheduler: shared supervisor failed: {error}", flush=True)
        finally:
            if process is not None:
                terminate_supervisor(process)
        while True:
            try:
                released = scheduler_request(f"/v1/claims/{claim_id}/release", {
                    "projectId": scheduler_project_id,
                    "hostId": scheduler_host_id,
                })
                break
            except (OSError, TimeoutError, json.JSONDecodeError) as error:
                failures += 1
                delay = min(2 ** max(failures, 1), 30)
                print(f"qemu-ci-scheduler: shared claim release failed: {error}; retrying in {delay}s", flush=True)
                if shutdown.wait(delay):
                    break

`;
