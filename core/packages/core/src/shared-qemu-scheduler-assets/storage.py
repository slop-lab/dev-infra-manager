from __future__ import annotations

from pathlib import Path
import os
import sqlite3
import stat


def prepare_database_path(path: Path) -> None:
    parent_metadata = path.parent.lstat()
    if not stat.S_ISDIR(parent_metadata.st_mode) or parent_metadata.st_mode & 0o077:
        raise PermissionError("scheduler database directory must be a private directory")
    if hasattr(os, "getuid") and parent_metadata.st_uid != os.getuid():
        raise PermissionError("scheduler database directory must be owned by the service user")
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        os.close(descriptor)
        return
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_mode & 0o077:
        raise PermissionError("scheduler database must be a mode-0600 regular file")
    if hasattr(os, "getuid") and metadata.st_uid != os.getuid():
        raise PermissionError("scheduler database must be owned by the service user")


class Transaction:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self._connection = connection

    def __enter__(self) -> sqlite3.Connection:
        return self._connection

    def __exit__(self, exception_type: type[BaseException] | None, _exception: BaseException | None, _traceback: object) -> None:
        try:
            self._connection.execute("COMMIT" if exception_type is None else "ROLLBACK")
        finally:
            self._connection.close()
