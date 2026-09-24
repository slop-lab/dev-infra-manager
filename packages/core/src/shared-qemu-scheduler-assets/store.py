from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Callable
import json
import secrets
import sqlite3
import time

from protocol import HostId, ProjectId


@dataclass(frozen=True, slots=True)
class Lease:
    job_id: int
    claim_id: str
    expires_at: float


class SchedulerStore:
    def __init__(self, path: Path, lease_seconds: int, clock: Callable[[], float] = time.time) -> None:
        self._path = path
        self._lease_seconds = lease_seconds
        self._clock = clock
        path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.executescript("""
                CREATE TABLE IF NOT EXISTS jobs (
                    project_id TEXT NOT NULL,
                    job_id INTEGER NOT NULL,
                    state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed')),
                    labels TEXT NOT NULL,
                    completed_at REAL,
                    updated_at REAL NOT NULL,
                    PRIMARY KEY (project_id, job_id)
                );
                CREATE TABLE IF NOT EXISTS claims (
                    claim_id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL,
                    job_id INTEGER NOT NULL,
                    host_id TEXT NOT NULL,
                    capacity TEXT NOT NULL,
                    request_id TEXT NOT NULL,
                    expires_at REAL NOT NULL,
                    detached INTEGER NOT NULL DEFAULT 0 CHECK (detached IN (0, 1)),
                    UNIQUE (project_id, job_id),
                    UNIQUE (project_id, host_id, capacity),
                    UNIQUE (project_id, host_id, request_id)
                );
            """)

    def record_event(self, project_id: ProjectId, action: str, job_id: int, labels: tuple[str, ...]) -> None:
        now = self._clock()
        with self._transaction() as connection:
            self._prune(connection, now)
            row = connection.execute(
                "SELECT state, completed_at FROM jobs WHERE project_id = ? AND job_id = ?",
                (project_id, job_id),
            ).fetchone()
            current = None if row is None else str(row[0])
            rank = {"queued": 1, "running": 2, "in_progress": 2, "completed": 3}
            if current == "completed" or rank[action] < rank.get(current or "", 0):
                return
            state = "running" if action == "in_progress" else action
            completed_at = now if state == "completed" and (row is None or row[1] is None) else (None if row is None else row[1])
            connection.execute(
                "INSERT INTO jobs(project_id, job_id, state, labels, completed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(project_id, job_id) DO UPDATE SET state=excluded.state, labels=excluded.labels, "
                "completed_at=COALESCE(jobs.completed_at, excluded.completed_at), updated_at=excluded.updated_at",
                (project_id, job_id, state, json.dumps(labels), completed_at, now),
            )
            if state != "queued":
                connection.execute(
                    "UPDATE claims SET detached = 1 WHERE project_id = ? AND job_id = ?",
                    (project_id, job_id),
                )

    def claim(self, project_id: ProjectId, host_id: HostId, capacity: str, labels: tuple[str, ...], request_id: str) -> Lease | None:
        now = self._clock()
        with self._transaction() as connection:
            self._prune(connection, now)
            prior = connection.execute(
                "SELECT job_id, claim_id, expires_at FROM claims WHERE project_id = ? AND host_id = ? AND request_id = ?",
                (project_id, host_id, request_id),
            ).fetchone()
            if prior is not None:
                return Lease(int(prior[0]), str(prior[1]), float(prior[2]))
            busy = connection.execute(
                "SELECT 1 FROM claims WHERE project_id = ? AND host_id = ? AND capacity = ?",
                (project_id, host_id, capacity),
            ).fetchone()
            if busy is not None:
                return None
            rows = connection.execute(
                "SELECT job_id, labels FROM jobs WHERE project_id = ? AND state = 'queued' "
                "AND NOT EXISTS (SELECT 1 FROM claims WHERE claims.project_id = jobs.project_id AND claims.job_id = jobs.job_id) "
                "ORDER BY job_id",
                (project_id,),
            ).fetchall()
            selected = next((int(row[0]) for row in rows if not set(json.loads(str(row[1]))).isdisjoint(labels)), None)
            if selected is None:
                return None
            claim_id = secrets.token_urlsafe(32)
            expires_at = now + self._lease_seconds
            connection.execute(
                "INSERT INTO claims(claim_id, project_id, job_id, host_id, capacity, request_id, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (claim_id, project_id, selected, host_id, capacity, request_id, expires_at),
            )
            return Lease(selected, claim_id, expires_at)

    def renew(self, project_id: ProjectId, host_id: HostId, claim_id: str) -> str:
        now = self._clock()
        with self._transaction() as connection:
            self._prune(connection, now)
            row = connection.execute(
                "SELECT detached FROM claims WHERE project_id = ? AND host_id = ? AND claim_id = ?",
                (project_id, host_id, claim_id),
            ).fetchone()
            if row is None:
                return "lost"
            if int(row[0]) == 1:
                return "detached"
            connection.execute("UPDATE claims SET expires_at = ? WHERE claim_id = ?", (now + self._lease_seconds, claim_id))
            return "renewed"

    def release(self, project_id: ProjectId, host_id: HostId, claim_id: str) -> bool:
        with self._transaction() as connection:
            removed = connection.execute(
                "DELETE FROM claims WHERE project_id = ? AND host_id = ? AND claim_id = ?",
                (project_id, host_id, claim_id),
            )
            return removed.rowcount == 1

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self._path, timeout=5, isolation_level=None)
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=FULL")
        connection.execute("PRAGMA busy_timeout=5000")
        return connection

    def _transaction(self) -> sqlite3.Connection:
        connection = self._connect()
        connection.execute("BEGIN IMMEDIATE")
        return _Transaction(connection)

    @staticmethod
    def _prune(connection: sqlite3.Connection, now: float) -> None:
        connection.execute("DELETE FROM claims WHERE expires_at <= ?", (now,))
        connection.execute("DELETE FROM jobs WHERE state = 'completed' AND completed_at < ?", (now - 7 * 24 * 60 * 60,))


class _Transaction:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self._connection = connection

    def __enter__(self) -> sqlite3.Connection:
        return self._connection

    def __exit__(self, exception_type: type[BaseException] | None, _exception: BaseException | None, _traceback: object) -> None:
        try:
            self._connection.execute("COMMIT" if exception_type is None else "ROLLBACK")
        finally:
            self._connection.close()
