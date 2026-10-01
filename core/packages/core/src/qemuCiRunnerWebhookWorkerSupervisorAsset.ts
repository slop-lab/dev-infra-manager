export const QEMU_CI_WEBHOOK_WORKER_SUPERVISOR = `def terminate_supervisor(process):
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=5)
    else:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    reap_deadline = time.monotonic() + 5
    while True:
        try:
            reaped, _ = os.waitpid(-process.pid, os.WNOHANG)
        except ChildProcessError:
            break
        if reaped != 0:
            continue
        if time.monotonic() >= reap_deadline:
            raise TimeoutError("timed out reaping supervisor process group")
        shutdown.wait(0.01)

def sweep_run_residue():
    os.makedirs(run_root, exist_ok=True)
    with os.scandir(run_root) as entries:
        for entry in entries:
            if entry.name.startswith("job-"):
                if entry.is_dir(follow_symlinks=False):
                    shutil.rmtree(entry.path)
                else:
                    os.unlink(entry.path)

def worker():
    failures = 0
    while not shutdown.is_set():
        now = time.time()
        def claim_one(state):
            if shutdown.is_set():
                return None
            for job_id, claim in list(state["claims"].items()):
                if job_id not in state["running"] and (
                    job_id not in state["queued"] or now - float(claim.get("updated", 0)) > lease_seconds
                ):
                    del state["claims"][job_id]
            available = sorted(state["queued"] - state["claims"].keys())
            if not available:
                return None
            job_id = available[0]
            state["claims"][job_id] = {"owner": capacity, "updated": now}
            return job_id
        try:
            trigger_job_id = locked_update(claim_one)
        except Exception as error:
            failures += 1
            delay = min(2 ** max(failures, 1), 30)
            print(
                f"qemu-ci-scheduler: claim state update failed: {error}; retrying in {delay}s",
                flush=True,
            )
            if shutdown.wait(delay):
                break
            continue
        if trigger_job_id is None:
            shutdown.wait(1)
            continue
        print(f"qemu-ci-scheduler: capacity {capacity} claimed queued trigger job {trigger_job_id}", flush=True)
        process = None
        try:
            process = subprocess.Popen(
                ["bash", "/usr/local/bin/dim-qemu-ci-supervise"],
                start_new_session=True,
            )
            renewing_trigger = True
            while process.poll() is None:
                if shutdown.wait(heartbeat_seconds):
                    break
                if not renewing_trigger:
                    continue
                def renew(state):
                    claim = state["claims"].get(trigger_job_id)
                    if claim and claim.get("owner") == capacity:
                        claim["updated"] = time.time()
                        return True
                    return False
                if not locked_update(renew):
                    print(
                        f"qemu-ci-scheduler: capacity {capacity} lost trigger claim ownership for job {trigger_job_id}",
                        flush=True,
                    )
                    renewing_trigger = False
            if process.poll() is not None and process.returncode != 0:
                raise subprocess.CalledProcessError(process.returncode, process.args)
            if process.poll() is not None:
                failures = 0
        except subprocess.CalledProcessError as error:
            print(
                f"qemu-ci-scheduler: supervisor failed: exit {error.returncode}",
                flush=True,
            )
            failures += 1
        except Exception as error:
            print(
                f"qemu-ci-scheduler: supervisor failed: {error}",
                flush=True,
            )
            failures += 1
        finally:
            if process is not None:
                terminate_supervisor(process)
        def release_claim(state):
            claim = state["claims"].get(trigger_job_id)
            if not claim or claim.get("owner") != capacity:
                return False
            if trigger_job_id not in state["running"]:
                del state["claims"][trigger_job_id]
            return trigger_job_id in state["queued"]
        retry = False
        while True:
            try:
                retry = locked_update(release_claim)
                break
            except Exception as error:
                failures += 1
                delay = min(2 ** max(failures, 1), 30)
                print(
                    f"qemu-ci-scheduler: claim release failed: {error}; retrying in {delay}s",
                    flush=True,
                )
                if shutdown.wait(delay):
                    break
        if retry:
            delay = min(2 ** max(failures, 1), 30)
            print(
                f"qemu-ci-scheduler: queued demand remains; retrying in {delay}s",
                flush=True,
            )
            shutdown.wait(delay)

`;
