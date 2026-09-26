from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
from typing import Iterator
import fcntl
import hashlib
import os
import signal
import subprocess
import time

from protocol import Config, Credential, JsonValue, ProtocolError, Repository


class GitOperationError(RuntimeError):
    pass


class RepositoryBusyError(RuntimeError):
    pass


def fetch_repository(config: Config, repository: Repository, request: dict[str, JsonValue]) -> None:
    expected = {"externalUrl", "refNamespace", "prune", "externalCredential", "managedCredential"}
    if set(request) != expected or type(request["prune"]) is not bool:
        raise ProtocolError("invalid fetch request")
    external_url = request["externalUrl"]
    if type(external_url) is not str:
        raise ProtocolError("externalUrl must be a string")
    external = _credential(request["externalCredential"], "externalCredential")
    managed = _credential(request["managedCredential"], "managedCredential")
    namespace = _namespace(request["refNamespace"])
    with repository_lock(config, repository):
        _assert_bare(repository, config.timeout_seconds)
        _clear_staging(repository, config.timeout_seconds)
        try:
            _configure_remote(repository, external_url, namespace, config.timeout_seconds)
            _run(repository, ["fetch", "--atomic", "--no-tags", "dim-upstream"], external, config.timeout_seconds)
            refspecs = _fetch_refspecs(repository, namespace, bool(request["prune"]), managed, config.timeout_seconds)
            if refspecs:
                _run(repository, ["push", "--atomic", repository.managed_url, *refspecs], managed, config.timeout_seconds)
        finally:
            _clear_staging(repository, config.timeout_seconds)


def publish_repository(config: Config, repository: Repository, request: dict[str, JsonValue]) -> None:
    expected = {"externalUrl", "refNamespace", "publishBranches", "externalCredential"}
    if set(request) != expected:
        raise ProtocolError("invalid publish request")
    external_url = request["externalUrl"]
    if type(external_url) is not str:
        raise ProtocolError("externalUrl must be a string")
    namespace = _namespace(request["refNamespace"])
    branches = _branch_map(request["publishBranches"], "publishBranches")
    if not branches:
        raise ProtocolError("publishBranches must not be empty")
    external = _credential(request["externalCredential"], "externalCredential")
    with repository_lock(config, repository):
        _assert_bare(repository, config.timeout_seconds)
        _clear_staging(repository, config.timeout_seconds)
        try:
            _configure_remote(repository, external_url, namespace, config.timeout_seconds)
            refspecs = [f"refs/heads/{source}:{_map_to_external(namespace, destination)}" for source, destination in sorted(branches.items())]
            _run(repository, ["push", "dim-upstream", *refspecs], external, config.timeout_seconds)
        finally:
            _clear_staging(repository, config.timeout_seconds)


@contextmanager
def repository_lock(config: Config, repository: Repository) -> Iterator[None]:
    locks = config.state_root / "locks"
    locks.mkdir(mode=0o700, exist_ok=True)
    identity = hashlib.sha256(str(repository.path).encode()).hexdigest()
    with (locks / identity).open("a+b") as lock:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RepositoryBusyError() from error
        yield


def _configure_remote(repository: Repository, external_url: str, namespace: dict[str, JsonValue] | None, timeout: int) -> None:
    _run(repository, ["config", "--local", "--replace-all", "remote.dim-upstream.url", external_url], None, timeout)
    _run(repository, ["config", "--local", "--unset-all", "remote.dim-upstream.fetch"], None, timeout, {0, 5})
    for refspec in _remote_refspecs(namespace):
        _run(repository, ["config", "--local", "--add", "remote.dim-upstream.fetch", refspec], None, timeout)
    _run(repository, ["config", "--local", "--unset-all", "uploadpack.hideRefs", "^refs/dim-sync/$"], None, timeout, {0, 5})
    _run(repository, ["config", "--local", "--add", "uploadpack.hideRefs", "refs/dim-sync/"], None, timeout)


def _remote_refspecs(namespace: dict[str, JsonValue] | None) -> list[str]:
    if namespace is not None and "branches" in namespace:
        branches = _branch_map(namespace["branches"], "refNamespace.branches")
        return [f"+refs/heads/{external}:refs/dim-sync/raw/heads/{external}" for external in sorted(branches.values())]
    if namespace is not None and "prefix" in namespace:
        prefix = namespace["prefix"]
        if type(prefix) is not str:
            raise ProtocolError("refNamespace.prefix must be a string")
        return [f"+refs/heads/{prefix}*:refs/dim-sync/raw/heads/{prefix}*", f"refs/tags/{prefix}*:refs/dim-sync/raw/tags/{prefix}*"]
    return ["+refs/heads/*:refs/dim-sync/raw/heads/*", "refs/tags/*:refs/dim-sync/raw/tags/*"]


def _fetch_refspecs(repository: Repository, namespace: dict[str, JsonValue] | None, prune: bool, credential: Credential | None, timeout: int) -> list[str]:
    refs = _lines(_run(repository, ["for-each-ref", "--format=%(refname)", "refs/dim-sync/raw"], None, timeout))
    result: list[str] = []
    targets: set[str] = set()
    for source in refs:
        external_ref = source.replace("refs/dim-sync/raw/heads/", "refs/heads/", 1) if source.startswith("refs/dim-sync/raw/heads/") else source.replace("refs/dim-sync/raw/tags/", "refs/tags/", 1)
        mapped = _map_from_external(namespace, external_ref)
        if mapped is None:
            continue
        target = f"refs/heads/upstream/{mapped.removeprefix('refs/heads/')}" if mapped.startswith("refs/heads/") else mapped
        targets.add(target)
        result.append(f"{ '+' if target.startswith('refs/heads/upstream/') else ''}{source}:{target}")
    if prune:
        remote = _run(repository, ["ls-remote", "--refs", repository.managed_url, "refs/heads/upstream/*"], credential, timeout)
        result.extend(f":{ref}" for ref in _lines(remote, column=1) if ref not in targets)
    return result


def _map_from_external(namespace: dict[str, JsonValue] | None, ref: str) -> str | None:
    base, name = _split_ref(ref)
    if namespace is None:
        return ref
    if "branches" in namespace:
        if base != "refs/heads/":
            return None
        branches = _branch_map(namespace["branches"], "refNamespace.branches")
        return next((f"refs/heads/{managed}" for managed, external in branches.items() if external == name), None)
    if "prefix" in namespace:
        prefix = namespace["prefix"]
        return f"{base}{name.removeprefix(prefix)}" if type(prefix) is str and name.startswith(prefix) else None
    excluded = namespace.get("excludedPrefixes", [])
    return None if type(excluded) is list and any(type(prefix) is str and name.startswith(prefix) for prefix in excluded) else ref


def _map_to_external(namespace: dict[str, JsonValue] | None, branch: str) -> str:
    if namespace is None:
        return f"refs/heads/{branch}"
    if "branches" in namespace:
        branches = _branch_map(namespace["branches"], "refNamespace.branches")
        external = branches.get(branch)
        if external is None:
            raise ProtocolError("publish destination is outside reviewed import mapping")
        return f"refs/heads/{external}"
    if "prefix" in namespace:
        prefix = namespace["prefix"]
        if type(prefix) is not str:
            raise ProtocolError("refNamespace.prefix must be a string")
        return f"refs/heads/{prefix}{branch}"
    excluded = namespace.get("excludedPrefixes", [])
    if type(excluded) is list and any(type(prefix) is str and branch.startswith(prefix) for prefix in excluded):
        raise ProtocolError("publish destination belongs to another repository prefix")
    return f"refs/heads/{branch}"


def _namespace(value: JsonValue) -> dict[str, JsonValue] | None:
    if value is None:
        return None
    if type(value) is not dict:
        raise ProtocolError("invalid refNamespace")
    if set(value) == {"prefix"}:
        prefix = value["prefix"]
        if type(prefix) is not str or not prefix.endswith("/") or not _safe_branch(prefix.removesuffix("/")):
            raise ProtocolError("refNamespace.prefix is invalid")
        return value
    if set(value) == {"fallback", "excludedPrefixes"}:
        excluded = value["excludedPrefixes"]
        if value["fallback"] is not True or type(excluded) is not list:
            raise ProtocolError("refNamespace fallback is invalid")
        if any(type(prefix) is not str or not prefix.endswith("/") or not _safe_branch(prefix.removesuffix("/")) for prefix in excluded):
            raise ProtocolError("refNamespace.excludedPrefixes is invalid")
        return value
    if set(value) == {"branches"} and _branch_map(value["branches"], "refNamespace.branches"):
        return value
    raise ProtocolError("refNamespace must select one mapping")


def _branch_map(value: JsonValue, name: str) -> dict[str, str]:
    if type(value) is not dict:
        raise ProtocolError(f"{name} must be an object")
    result: dict[str, str] = {}
    for source, destination in value.items():
        if type(source) is not str or type(destination) is not str or not _safe_branch(source) or not _safe_branch(destination):
            raise ProtocolError(f"{name} contains an invalid branch")
        result[source] = destination
    return result


def _safe_branch(value: str) -> bool:
    parts = value.split("/")
    return bool(
        value
        and not value.startswith(("-", "."))
        and not value.endswith(("/", ".", ".lock"))
        and ".." not in value
        and "@{" not in value
        and all(part and not part.startswith(".") and not part.endswith(".lock") for part in parts)
        and all(character.isalnum() or character in "._/-" for character in value)
    )


def _credential(value: JsonValue, name: str) -> Credential | None:
    if value is None:
        return None
    if type(value) is not dict or set(value) != {"username", "password"}:
        raise ProtocolError(f"invalid {name}")
    username, password = value["username"], value["password"]
    if type(username) is not str or type(password) is not str or not username or not password or "\n" in username or "\n" in password:
        raise ProtocolError(f"invalid {name}")
    return Credential(username, password)


def _assert_bare(repository: Repository, timeout: int) -> None:
    if not repository.path.is_dir() or _run(repository, ["rev-parse", "--is-bare-repository"], None, timeout).strip() != "true":
        raise GitOperationError()


def _clear_staging(repository: Repository, timeout: int) -> None:
    for ref in _lines(_run(repository, ["for-each-ref", "--format=%(refname)", "refs/dim-sync"], None, timeout)):
        _run(repository, ["update-ref", "-d", ref], None, timeout)


def _run(repository: Repository, args: list[str], credential: Credential | None, timeout: int, accepted: set[int] = {0}) -> str:
    environment = {"PATH": "/usr/bin:/bin", "HOME": os.environ.get("HOME", "/var/empty"), "LANG": "C.UTF-8", "GIT_TERMINAL_PROMPT": "0", "GIT_CONFIG_NOSYSTEM": "1"}
    if credential is not None:
        environment.update({
            "DIM_GIT_USERNAME": credential.username,
            "DIM_GIT_TOKEN": credential.password,
            "GIT_CONFIG_COUNT": "2",
            "GIT_CONFIG_KEY_0": "credential.helper",
            "GIT_CONFIG_VALUE_0": "",
            "GIT_CONFIG_KEY_1": "credential.helper",
            "GIT_CONFIG_VALUE_1": "!f() { printf '%s\\n' \"username=$DIM_GIT_USERNAME\" \"password=$DIM_GIT_TOKEN\"; }; f",
        })
    process = subprocess.Popen(["/usr/bin/git", "--git-dir", str(repository.path), *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=environment, start_new_session=True)
    try:
        stdout, _stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
        raise GitOperationError() from None
    if process.returncode not in accepted:
        raise GitOperationError()
    return stdout


def _lines(value: str, column: int = 0) -> list[str]:
    result: list[str] = []
    for line in value.splitlines():
        fields = line.split()
        if len(fields) > column:
            result.append(fields[column])
    return result


def _split_ref(ref: str) -> tuple[str, str]:
    for base in ("refs/heads/", "refs/tags/"):
        if ref.startswith(base):
            return base, ref.removeprefix(base)
    raise ProtocolError("unsupported ref")
