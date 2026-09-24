from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Final
import json
import secrets
import sqlite3
import time

from protocol import HostId, ProjectId
from storage import Transaction, prepare_database_path

MAX_QUEUED_JOBS: Final = 10_000
MAX_COMPLETED_JOBS: Final = 10_000


class StoreCapacityError(Exception):
    pass


@dataclass(frozen=True, slots=True)
class Lease:
    job_id: int
    claim_id: str
    expires_at: float
    lease_seconds: int


class SchedulerStore:
    def __init__(
        self,
        path: Path,
        lease_seconds: int,
        clock: Callable[[], float] = time.time,
        takeover_grace_seconds: int = 20,
        restart_hold_seconds: int = 20,
    ) -> None:
        self._path = path
        self._lease_seconds = lease_seconds
        self._clock = clock
        self._takeover_grace_seconds = takeover_grace_seconds
        self._restart_hold_seconds = restart_hold_seconds
        prepare_database_path(path)
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
                CREATE TABLE IF NOT EXISTS scheduler_meta (
                    key TEXT PRIMARY KEY,
                    value REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS claim_requests (
                    project_id TEXT NOT NULL,
                    host_id TEXT NOT NULL,
                    request_id TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    PRIMARY KEY (project_id, host_id, request_id)
                );
                CREATE TABLE IF NOT EXISTS job_labels (
                    project_id TEXT NOT NULL,
                    job_id INTEGER NOT NULL,
                    label TEXT NOT NULL,
                    PRIMARY KEY (project_id, job_id, label)
                );
                CREATE INDEX IF NOT EXISTS jobs_project_state_job ON jobs(project_id, state, job_id);
                CREATE INDEX IF NOT EXISTS job_labels_project_label_job ON job_labels(project_id, label, job_id);
            """)
        with self._transaction() as connection:
            now = self._now(connection)
            connection.execute(
                "UPDATE claims SET expires_at = MAX(expires_at, ?) "
                "WHERE expires_at + ? > ? AND EXISTS ("
                "SELECT 1 FROM jobs WHERE jobs.project_id = claims.project_id "
                "AND jobs.job_id = claims.job_id AND jobs.state = 'queued')",
                (now + self._restart_hold_seconds, self._takeover_grace_seconds, now),
            )

    def record_event(self, project_id: ProjectId, action: str, job_id: int, labels: tuple[str, ...]) -> str:
        with self._transaction() as connection:
            now = self._now(connection)
            self._prune(connection, now)
            row = connection.execute(
                "SELECT state, completed_at FROM jobs WHERE project_id = ? AND job_id = ?",
                (project_id, job_id),
            ).fetchone()
            current = None if row is None else str(row[0])
            rank = {"queued": 1, "running": 2, "in_progress": 2, "completed": 3}
            if action not in rank:
                raise ValueError("unsupported scheduler event action")
            if current == "completed" or rank[action] < rank.get(current or "", 0):
                return "ignored"
            state = "running" if action == "in_progress" else action
            if current is None:
                queued_count = int(connection.execute(
                    "SELECT COUNT(*) FROM jobs WHERE project_id = ? AND state = 'queued'",
                    (project_id,),
                ).fetchone()[0])
                if queued_count >= MAX_QUEUED_JOBS:
                    raise StoreCapacityError("queued demand limit reached")
            if state == "completed" and current != "completed":
                completed_count = int(connection.execute(
                    "SELECT COUNT(*) FROM jobs WHERE project_id = ? AND state = 'completed'",
                    (project_id,),
                ).fetchone()[0])
                if completed_count >= MAX_COMPLETED_JOBS:
                    connection.execute(
                        "DELETE FROM jobs WHERE rowid = (SELECT rowid FROM jobs WHERE project_id = ? "
                        "AND state = 'completed' ORDER BY completed_at, job_id LIMIT 1)",
                        (project_id,),
                    )
            completed_at = now if state == "completed" and (row is None or row[1] is None) else (None if row is None else row[1])
            connection.execute(
                "INSERT INTO jobs(project_id, job_id, state, labels, completed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(project_id, job_id) DO UPDATE SET state=excluded.state, "
                "completed_at=COALESCE(jobs.completed_at, excluded.completed_at), updated_at=excluded.updated_at",
                (project_id, job_id, state, json.dumps(labels), completed_at, now),
            )
            if current is None:
                connection.executemany(
                    "INSERT INTO job_labels(project_id, job_id, label) VALUES (?, ?, ?)",
                    ((project_id, job_id, label) for label in labels),
                )
            if state != "queued":
                connection.execute(
                    "UPDATE claims SET detached = 1 WHERE project_id = ? AND job_id = ?",
                    (project_id, job_id),
                )
            return "recorded"

    def claim(self, project_id: ProjectId, host_id: HostId, capacity: str, labels: tuple[str, ...], request_id: str) -> Lease | None:
        with self._transaction() as connection:
            now = self._now(connection)
            self._prune(connection, now)
            prior = connection.execute(
                "SELECT claims.job_id, claims.claim_id, claims.expires_at, claims.detached, jobs.state "
                "FROM claims JOIN jobs ON jobs.project_id = claims.project_id AND jobs.job_id = claims.job_id "
                "WHERE claims.project_id = ? AND claims.host_id = ? AND claims.request_id = ?",
                (project_id, host_id, request_id),
            ).fetchone()
            if prior is not None:
                if int(prior[3]) == 0 and str(prior[4]) == "queued" and float(prior[2]) > now:
                    return Lease(int(prior[0]), str(prior[1]), float(prior[2]), self._lease_seconds)
                return None
            previous_request = connection.execute(
                "SELECT 1 FROM claim_requests WHERE project_id = ? AND host_id = ? AND request_id = ?",
                (project_id, host_id, request_id),
            ).fetchone()
            if previous_request is not None:
                return None
            busy = connection.execute(
                "SELECT 1 FROM claims WHERE project_id = ? AND host_id = ? AND capacity = ?",
                (project_id, host_id, capacity),
            ).fetchone()
            if busy is not None:
                return None
            placeholders = ",".join("?" for _label in labels)
            row = connection.execute(
                "SELECT jobs.job_id FROM jobs JOIN job_labels ON job_labels.project_id = jobs.project_id "
                "AND job_labels.job_id = jobs.job_id WHERE jobs.project_id = ? AND jobs.state = 'queued' "
                f"AND job_labels.label IN ({placeholders}) "
                "AND NOT EXISTS (SELECT 1 FROM claims WHERE claims.project_id = jobs.project_id AND claims.job_id = jobs.job_id) "
                "ORDER BY jobs.job_id LIMIT 1",
                (project_id, *labels),
            ).fetchone()
            if row is None:
                return None
            selected = int(row[0])
            claim_id = secrets.token_urlsafe(32)
            expires_at = now + self._lease_seconds
            connection.execute(
                "INSERT INTO claims(claim_id, project_id, job_id, host_id, capacity, request_id, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (claim_id, project_id, selected, host_id, capacity, request_id, expires_at),
            )
            connection.execute(
                "INSERT INTO claim_requests(project_id, host_id, request_id, created_at) VALUES (?, ?, ?, ?)",
                (project_id, host_id, request_id, now),
            )
            return Lease(selected, claim_id, expires_at, self._lease_seconds)

    def renew(self, project_id: ProjectId, host_id: HostId, claim_id: str) -> str:
        with self._transaction() as connection:
            now = self._now(connection)
            self._prune(connection, now)
            row = connection.execute(
                "SELECT detached, expires_at FROM claims WHERE project_id = ? AND host_id = ? AND claim_id = ?",
                (project_id, host_id, claim_id),
            ).fetchone()
            if row is None:
                return "lost"
            if int(row[0]) == 1:
                return "detached"
            if float(row[1]) <= now:
                return "lost"
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

    def _transaction(self) -> Transaction:
        connection = self._connect()
        connection.execute("BEGIN IMMEDIATE")
        return Transaction(connection)

    def _prune(self, connection: sqlite3.Connection, now: float) -> None:
        connection.execute("DELETE FROM claims WHERE expires_at + ? <= ?", (self._takeover_grace_seconds, now))
        connection.execute("DELETE FROM jobs WHERE state = 'completed' AND completed_at < ?", (now - 7 * 24 * 60 * 60,))
        connection.execute("DELETE FROM job_labels WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.project_id = job_labels.project_id AND jobs.job_id = job_labels.job_id)")
        connection.execute(
            "DELETE FROM claim_requests WHERE created_at < ? AND NOT EXISTS ("
            "SELECT 1 FROM claims WHERE claims.project_id = claim_requests.project_id "
            "AND claims.host_id = claim_requests.host_id AND claims.request_id = claim_requests.request_id)",
            (now - 7 * 24 * 60 * 60,),
        )

    def _now(self, connection: sqlite3.Connection) -> float:
        wall_now = self._clock()
        row = connection.execute("SELECT value FROM scheduler_meta WHERE key = 'last_wall_clock'").fetchone()
        effective_now = wall_now if row is None else max(wall_now, float(row[0]))
        connection.execute(
            "INSERT INTO scheduler_meta(key, value) VALUES ('last_wall_clock', ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (effective_now,),
        )
        return effective_now
