from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import NewType
import json
import os
import stat

ProjectId = NewType("ProjectId", str)
HostId = NewType("HostId", str)


@dataclass(frozen=True, slots=True)
class ProjectAuth:
    webhook_token: str
    api_token: str
    labels: frozenset[str]


@dataclass(frozen=True, slots=True)
class ServiceConfig:
    host: str
    port: int
    database: Path
    lease_seconds: int
    projects: dict[ProjectId, ProjectAuth]


class ProtocolError(Exception):
    pass


def load_config(path: Path) -> ServiceConfig:
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_mode & 0o077:
        raise ProtocolError("scheduler config must be a mode-0600 regular file")
    if hasattr(os, "getuid") and metadata.st_uid != os.getuid():
        raise ProtocolError("scheduler config must be owned by the service user")
    value = strict_json_loads(path.read_text(encoding="utf-8"))
    root = exact_object(value, {"schemaVersion", "listen", "database", "leaseSeconds", "projects"}, "config")
    if root["schemaVersion"] != 1:
        raise ProtocolError("config.schemaVersion must be 1")
    listen = exact_object(root["listen"], {"host", "port"}, "listen")
    host = text(listen["host"], "listen.host")
    port = positive_integer(listen["port"], "listen.port", maximum=65535)
    lease_seconds = positive_integer(root["leaseSeconds"], "leaseSeconds", maximum=3600)
    if lease_seconds < 60:
        raise ProtocolError("leaseSeconds must be at least 60")
    database = Path(text(root["database"], "database"))
    if not database.is_absolute():
        raise ProtocolError("database must be an absolute path")
    projects_value = root["projects"]
    if type(projects_value) is not dict or not projects_value:
        raise ProtocolError("projects must be a non-empty object")
    projects: dict[ProjectId, ProjectAuth] = {}
    api_tokens: set[str] = set()
    for raw_project_id, raw_auth in projects_value.items():
        project_id = ProjectId(identifier(raw_project_id, "project ID"))
        auth = exact_object(raw_auth, {"webhookToken", "apiToken", "labels"}, f"project {project_id}")
        api_token = text(auth["apiToken"], "API token")
        if api_token in api_tokens:
            raise ProtocolError("project API tokens must be unique")
        api_tokens.add(api_token)
        projects[project_id] = ProjectAuth(
            text(auth["webhookToken"], "webhook token"),
            api_token,
            frozenset(string_array(auth["labels"], "Project labels")),
        )
    return ServiceConfig(host, port, database, lease_seconds, projects)


def strict_json_loads(encoded: str) -> object:
    def reject_constant(value: str) -> None:
        raise ProtocolError(f"invalid JSON constant {value}")

    def unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
        result: dict[str, object] = {}
        for key, value in pairs:
            if key in result:
                raise ProtocolError(f"duplicate JSON field {key}")
            result[key] = value
        return result

    return json.loads(encoded, parse_constant=reject_constant, object_pairs_hook=unique_object)


def exact_object(value: object, fields: set[str], label: str) -> dict[str, object]:
    if type(value) is not dict:
        raise ProtocolError(f"{label} must be an object")
    keys = set(value)
    if keys != fields:
        raise ProtocolError(f"{label} must contain exactly {', '.join(sorted(fields))}")
    return value


def text(value: object, label: str) -> str:
    if type(value) is not str or not value:
        raise ProtocolError(f"{label} must be a non-empty string")
    return value


def identifier(value: object, label: str) -> str:
    candidate = text(value, label)
    if len(candidate) > 128 or not all(character.isalnum() or character in "._-" for character in candidate):
        raise ProtocolError(f"{label} must use only letters, numbers, dot, underscore, or hyphen")
    return candidate


def positive_integer(value: object, label: str, maximum: int) -> int:
    if type(value) is not int or value < 1 or value > maximum:
        raise ProtocolError(f"{label} must be an integer from 1 through {maximum}")
    return value


def string_array(value: object, label: str, allow_empty: bool = False) -> tuple[str, ...]:
    if type(value) is not list or (not value and not allow_empty) or any(type(item) is not str for item in value):
        raise ProtocolError(f"{label} must be a string array")
    result = tuple(value)
    if len(result) != len(set(result)) or any(not item or len(item) > 128 for item in result):
        raise ProtocolError(f"{label} must contain unique non-empty values")
    return result
