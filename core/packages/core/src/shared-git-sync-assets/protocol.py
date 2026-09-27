from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Final, NewType
from urllib.parse import unquote, urlparse
import json
import os
import re

ProjectId = NewType("ProjectId", str)
RepositoryAlias = NewType("RepositoryAlias", str)
type JsonValue = str | int | float | bool | None | list[JsonValue] | dict[str, JsonValue]
SAFE_IDENTIFIER: Final = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
SAFE_SSH_PATH: Final = re.compile(r"^/?[A-Za-z0-9._/-]+$")
SAFE_HOST: Final = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$")


class ProtocolError(RuntimeError):
    pass


class RepositoryNotFoundError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class Credential:
    username: str
    password: str


@dataclass(frozen=True, slots=True)
class Repository:
    path: Path
    managed_url: str


@dataclass(frozen=True, slots=True)
class TransportPolicy:
    https_hosts: frozenset[str]
    http_hosts: frozenset[str]
    ssh_hosts: frozenset[str]
    local_roots: tuple[Path, ...]


@dataclass(frozen=True, slots=True)
class Config:
    host: str
    port: int
    state_root: Path
    api_token: str
    timeout_seconds: int
    transport_policy: TransportPolicy
    repositories: dict[tuple[ProjectId, RepositoryAlias], Repository]


def load_config(path: Path) -> Config:
    metadata = path.stat()
    if not path.is_file() or metadata.st_mode & 0o077:
        raise ProtocolError("config must be a mode-0600 regular file")
    value = strict_json(path.read_text(encoding="utf-8"))
    root = exact_object(value, {"schemaVersion", "listen", "repositoriesRoot", "stateRoot", "apiToken", "timeoutSeconds", "transportPolicy", "repositories"}, "config")
    if root["schemaVersion"] != 1:
        raise ProtocolError("unsupported config schema")
    listen = exact_object(root["listen"], {"host", "port"}, "listen")
    repositories_root = absolute_directory(root["repositoriesRoot"], "repositoriesRoot")
    state_root = absolute_path(root["stateRoot"], "stateRoot")
    state_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    policy = parse_policy(root["transportPolicy"])
    repositories_value = object_value(root["repositories"], "repositories")
    repositories: dict[tuple[ProjectId, RepositoryAlias], Repository] = {}
    for key, raw_repository in repositories_value.items():
        parts = key.split("/")
        if len(parts) != 2:
            raise ProtocolError("repository registry keys must be PROJECT_ID/ALIAS")
        project_id = ProjectId(identifier(parts[0], "project ID"))
        alias = RepositoryAlias(identifier(parts[1], "repository alias"))
        repository = exact_object(raw_repository, {"relativePath", "managedUrl"}, f"repository {key}")
        relative = text(repository["relativePath"], "relativePath")
        if Path(relative).is_absolute() or ".." in Path(relative).parts:
            raise ProtocolError("repository relativePath must stay below repositoriesRoot")
        target = (repositories_root / relative).resolve()
        if not target.is_relative_to(repositories_root):
            raise ProtocolError("repository path escapes repositoriesRoot")
        repositories[(project_id, alias)] = Repository(target, credential_free_url(repository["managedUrl"], "managedUrl"))
    return Config(
        text(listen["host"], "listen.host"),
        integer(listen["port"], "listen.port", 1, 65535),
        state_root,
        text(root["apiToken"], "apiToken"),
        integer(root["timeoutSeconds"], "timeoutSeconds", 10, 3600),
        policy,
        repositories,
    )


def parse_repository_path(path: str) -> tuple[ProjectId, RepositoryAlias, str]:
    parts = path.split("/")
    if len(parts) != 6 or parts[:3] != ["", "v1", "repositories"] or parts[5] not in {"fetch", "publish"}:
        raise RepositoryNotFoundError()
    return ProjectId(identifier(unquote(parts[3]), "project ID")), RepositoryAlias(identifier(unquote(parts[4]), "repository alias")), parts[5]


def parse_credential(value: JsonValue, name: str) -> Credential | None:
    if value is None:
        return None
    credential = exact_object(value, {"username", "password"}, name)
    return Credential(text(credential["username"], f"{name}.username"), text(credential["password"], f"{name}.password"))


def validate_external_url(value: JsonValue, policy: TransportPolicy) -> str:
    raw = text(value, "externalUrl")
    if raw.startswith("/"):
        target = Path(raw).resolve()
        if not any(target.is_relative_to(root) for root in policy.local_roots):
            raise ProtocolError("local upstream is outside allowed roots")
        return raw
    if re.match(r"^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+:", raw) and "://" not in raw:
        authority, remote_path = raw.split(":", 1)
        host = authority.rsplit("@", 1)[-1].lower()
        if host not in policy.ssh_hosts or not SAFE_SSH_PATH.fullmatch(remote_path) or ".." in Path(remote_path).parts:
            raise ProtocolError("SSH upstream is not allowed")
        return raw
    try:
        parsed = urlparse(raw)
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ProtocolError("upstream URL must not contain credentials, query, or fragment")
        host = (parsed.hostname or "").lower()
    except ValueError as error:
        raise ProtocolError("upstream URL is malformed") from error
    if parsed.scheme == "https" and host in policy.https_hosts:
        return raw
    if parsed.scheme == "http" and host in policy.http_hosts:
        return raw
    if parsed.scheme == "ssh" and host in policy.ssh_hosts and SAFE_SSH_PATH.fullmatch(parsed.path) and ".." not in Path(parsed.path).parts:
        return raw
    if parsed.scheme == "file" and parsed.hostname in {None, "", "localhost"}:
        target = Path(unquote(parsed.path)).resolve()
        if any(target.is_relative_to(root) for root in policy.local_roots):
            return raw
    raise ProtocolError("upstream transport is not allowed")


def strict_json(value: str) -> JsonValue:
    def reject_constant(_value: str) -> None:
        raise ProtocolError("non-finite JSON numbers are not allowed")
    def reject_duplicates(pairs: list[tuple[str, JsonValue]]) -> dict[str, JsonValue]:
        result: dict[str, JsonValue] = {}
        for key, item in pairs:
            if key in result:
                raise ProtocolError("duplicate JSON key")
            result[key] = item
        return result
    return json.loads(value, parse_constant=reject_constant, object_pairs_hook=reject_duplicates)


def exact_object(value: JsonValue, fields: set[str], name: str) -> dict[str, JsonValue]:
    result = object_value(value, name)
    if set(result) != fields:
        raise ProtocolError(f"{name} has invalid fields")
    return result


def object_value(value: JsonValue, name: str) -> dict[str, JsonValue]:
    if type(value) is not dict:
        raise ProtocolError(f"{name} must be an object")
    return value


def text(value: JsonValue, name: str) -> str:
    if type(value) is not str or not value or "\x00" in value or "\n" in value:
        raise ProtocolError(f"{name} must be a non-empty single-line string")
    return value


def identifier(value: str, name: str) -> str:
    if not SAFE_IDENTIFIER.fullmatch(value):
        raise ProtocolError(f"{name} is not a safe identifier")
    return value


def integer(value: JsonValue, name: str, minimum: int, maximum: int) -> int:
    if type(value) is not int or value < minimum or value > maximum:
        raise ProtocolError(f"{name} is outside its allowed range")
    return value


def parse_policy(value: JsonValue) -> TransportPolicy:
    policy = exact_object(value, {"httpsHosts", "httpHosts", "sshHosts", "localRoots"}, "transportPolicy")
    return TransportPolicy(
        frozenset(hosts(policy["httpsHosts"], "httpsHosts")),
        frozenset(hosts(policy["httpHosts"], "httpHosts")),
        frozenset(hosts(policy["sshHosts"], "sshHosts")),
        tuple(absolute_directory(item, "localRoots") for item in string_list(policy["localRoots"], "localRoots")),
    )


def hosts(value: JsonValue, name: str) -> list[str]:
    result = string_list(value, name)
    if any(not SAFE_HOST.fullmatch(item) for item in result):
        raise ProtocolError(f"{name} contains an invalid host")
    return [item.lower() for item in result]


def string_list(value: JsonValue, name: str) -> list[str]:
    if type(value) is not list or any(type(item) is not str or not item for item in value):
        raise ProtocolError(f"{name} must be a string array")
    return value


def absolute_path(value: JsonValue, name: str) -> Path:
    path = Path(text(value, name))
    if not path.is_absolute():
        raise ProtocolError(f"{name} must be absolute")
    return path.resolve()


def absolute_directory(value: JsonValue, name: str) -> Path:
    path = absolute_path(value, name)
    if not path.is_dir():
        raise ProtocolError(f"{name} must be an existing directory")
    return path


def credential_free_url(value: JsonValue, name: str) -> str:
    raw = text(value, name)
    try:
        parsed = urlparse(raw)
        username = parsed.username
        password = parsed.password
    except ValueError as error:
        raise ProtocolError(f"{name} is malformed") from error
    if parsed.scheme not in {"http", "https"} or username or password or parsed.query or parsed.fragment:
        raise ProtocolError(f"{name} must be a credential-free HTTP URL")
    return raw
