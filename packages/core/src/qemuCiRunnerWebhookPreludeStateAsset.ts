export const QEMU_CI_WEBHOOK_PRELUDE_STATE = `#!/usr/bin/env python3
import ctypes
import hmac
import fcntl
import json
import math
import os
import signal
import shutil
import subprocess
import threading
import time
import secrets
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

authorization = os.environ["DIM_QEMU_WEBHOOK_AUTHORIZATION"]
capacity = os.environ["DIM_QEMU_CI_CAPACITY"]
dispatch_labels = frozenset(os.environ["DIM_QEMU_CI_LABELS"].split(","))
state_path = os.environ.get(
    "DIM_QEMU_SCHEDULER_STATE",
    "/var/lib/dim-qemu-ci-dispatch/demand.json",
)
lock_path = state_path + ".lock"
lease_seconds = 30
completed_retention_seconds = 7 * 24 * 60 * 60
heartbeat_seconds = float(os.environ.get("DIM_QEMU_SCHEDULER_HEARTBEAT_SECONDS", "5"))
scheduler_endpoint = os.environ.get("DIM_QEMU_SCHEDULER_ENDPOINT", "").rstrip("/")
scheduler_project_id = os.environ.get("DIM_QEMU_SCHEDULER_PROJECT_ID", "")
scheduler_host_id = os.environ.get("DIM_QEMU_SCHEDULER_HOST_ID", "")
scheduler_token = os.environ.get("DIM_QEMU_SCHEDULER_TOKEN", "")
run_root = "/var/lib/dim-qemu-ci/runs"
shutdown = threading.Event()
pr_set_child_subreaper = 36
libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(pr_set_child_subreaper, 1, 0, 0, 0) != 0:
    error_number = ctypes.get_errno()
    raise OSError(error_number, os.strerror(error_number))

class StateSchemaError(ValueError):
    pass

def state_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise StateSchemaError(f"duplicate state field: {key}")
        value[key] = item
    return value

def reject_json_constant(value):
    raise StateSchemaError(f"invalid JSON number: {value}")

def job_ids(value, field):
    if type(value) is not list or any(type(job_id) is not int for job_id in value):
        raise StateSchemaError(f"{field} must be an array of integers")
    if len(value) != len(set(value)):
        raise StateSchemaError(f"{field} must not contain duplicates")
    return set(value)

def job_id_key(value, field):
    try:
        job_id = int(value)
    except ValueError as error:
        raise StateSchemaError(f"{field} keys must be canonical integers") from error
    if str(job_id) != value:
        raise StateSchemaError(f"{field} keys must be canonical integers")
    return job_id

def finite_number(value, field):
    if type(value) not in (int, float) or not math.isfinite(value):
        raise StateSchemaError(f"{field} must be a finite number")
    return float(value)

def parse_state(value):
    if type(value) is not dict:
        raise StateSchemaError("state must be an object")
    fields = set(value)
    if not {"queued", "running", "claims"}.issubset(fields) or not fields.issubset({"queued", "running", "claims", "completed"}):
        raise StateSchemaError("state must contain queued, running, claims, and optional completed fields only")
    queued = job_ids(value["queued"], "queued")
    running = job_ids(value["running"], "running")
    if type(value["claims"]) is not dict:
        raise StateSchemaError("claims must be an object")
    claims = {}
    for key, claim in value["claims"].items():
        if type(claim) is not dict or set(claim) != {"owner", "updated"}:
            raise StateSchemaError("each claim must contain exactly owner and updated")
        if type(claim["owner"]) is not str:
            raise StateSchemaError("claim owner must be a string")
        claims[job_id_key(key, "claims")] = {
            "owner": claim["owner"],
            "updated": finite_number(claim["updated"], "claim updated"),
        }
    completed_value = value.get("completed", {})
    if type(completed_value) is not dict:
        raise StateSchemaError("completed must be an object")
    completed = {
        job_id_key(key, "completed"): finite_number(timestamp, "completed timestamp")
        for key, timestamp in completed_value.items()
    }
    return {"queued": queued, "running": running, "claims": claims, "completed": completed}

def load_state_unlocked():
    try:
        with open(state_path, encoding="utf-8") as source:
            value = json.load(
                source,
                object_pairs_hook=state_object,
                parse_constant=reject_json_constant,
            )
        return parse_state(value)
    except FileNotFoundError:
        return {"queued": set(), "running": set(), "claims": {}, "completed": {}}

def save_state_unlocked(state):
    directory = os.path.dirname(state_path) or "."
    os.makedirs(directory, exist_ok=True)
    temporary = f"{state_path}.{capacity}.{os.getpid()}.tmp"
    with open(temporary, "w", encoding="utf-8") as output:
        json.dump({
            "queued": sorted(state["queued"]),
            "running": sorted(state["running"]),
            "claims": {str(key): value for key, value in state["claims"].items()},
            "completed": {str(key): value for key, value in state["completed"].items()},
        }, output)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, state_path)
    directory_descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory_descriptor)
    finally:
        os.close(directory_descriptor)

def locked_update(update):
    os.makedirs(os.path.dirname(state_path) or ".", exist_ok=True)
    with open(lock_path, "a+", encoding="utf-8") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state = load_state_unlocked()
        now = time.time()
        state["completed"] = {
            job_id: timestamp
            for job_id, timestamp in state["completed"].items()
            if now - timestamp <= completed_retention_seconds
        }
        state["running"].difference_update(state["completed"])
        state["queued"].difference_update(state["running"] | state["completed"].keys())
        result = update(state)
        save_state_unlocked(state)
        return result

`;
