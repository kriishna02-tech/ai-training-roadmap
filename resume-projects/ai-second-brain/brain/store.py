import json
import sqlite3
import time
import uuid
from contextlib import contextmanager
from pathlib import Path


class Store:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        with self.connection() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY, owner TEXT NOT NULL, source_id TEXT NOT NULL,
                    text TEXT NOT NULL, file_path TEXT, mime TEXT, status TEXT NOT NULL,
                    attempts INTEGER NOT NULL DEFAULT 0, lease_until REAL NOT NULL DEFAULT 0,
                    lease_token TEXT, available_at REAL NOT NULL DEFAULT 0,
                    error TEXT, summary TEXT, transcript TEXT, created_at REAL NOT NULL,
                    UNIQUE(owner, source_id)
                );
                CREATE INDEX IF NOT EXISTS job_queue ON jobs(status, available_at, lease_until);
                CREATE TABLE IF NOT EXISTS memories (
                    id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id),
                    owner TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
                    kind TEXT NOT NULL, tags TEXT NOT NULL
                );
            """)

    @contextmanager
    def connection(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        try:
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def enqueue(self, owner, text, source_id=None, file_path=None, mime=None):
        source_id = source_id or str(uuid.uuid4())
        with self.connection() as db:
            db.execute("""INSERT OR IGNORE INTO jobs
                (id,owner,source_id,text,file_path,mime,status,created_at)
                VALUES (?,?,?,?,?,?,'pending',?)""",
                (str(uuid.uuid4()), owner, source_id, text, file_path, mime, time.time()))
            return dict(db.execute("SELECT * FROM jobs WHERE owner=? AND source_id=?",
                                   (owner, source_id)).fetchone())

    def claim(self, size, lease_seconds, max_attempts):
        now = time.time()
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("""UPDATE jobs SET status='failed', error='Worker lease expired'
                WHERE status='processing' AND lease_until < ? AND attempts >= ?""",
                (now, max_attempts))
            rows = db.execute("""SELECT id FROM jobs WHERE attempts < ? AND
                ((status='pending' AND available_at<=?) OR
                 (status='processing' AND lease_until<?)) ORDER BY created_at LIMIT ?""",
                (max_attempts, now, now, size)).fetchall()
            claimed = []
            for row in rows:
                token = str(uuid.uuid4())
                db.execute("""UPDATE jobs SET status='processing', attempts=attempts+1,
                    lease_until=?, lease_token=? WHERE id=?""",
                    (now + lease_seconds, token, row["id"]))
                claimed.append(dict(db.execute("SELECT * FROM jobs WHERE id=?", (row["id"],)).fetchone()))
            return claimed

    def is_current(self, job):
        with self.connection() as db:
            return db.execute("""SELECT 1 FROM jobs WHERE id=? AND status='processing'
                AND lease_token=? AND lease_until>?""",
                (job["id"], job["lease_token"], time.time())).fetchone() is not None

    def complete(self, job, extraction, memories):
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            changed = db.execute("""UPDATE jobs SET status='ready', summary=?, transcript=?,
                error=NULL, lease_until=0 WHERE id=? AND lease_token=? AND status='processing'
                AND lease_until>?""",
                (extraction.summary, extraction.transcript, job["id"], job["lease_token"], time.time()))
            if changed.rowcount != 1:
                return False
            db.execute("DELETE FROM memories WHERE job_id=?", (job["id"],))
            for memory in memories:
                db.execute("INSERT INTO memories VALUES (?,?,?,?,?,?,?)",
                    (memory["id"], job["id"], job["owner"], memory["title"],
                     memory["content"], memory["kind"], json.dumps(memory["tags"])))
            return True

    def fail(self, job, error, max_attempts):
        with self.connection() as db:
            db.execute("""UPDATE jobs SET status=?, error=?, available_at=?, lease_until=0
                WHERE id=? AND lease_token=? AND status='processing'""",
                ("failed" if job["attempts"] >= max_attempts else "pending",
                 error, time.time() + min(60, 2 ** job["attempts"]), job["id"], job["lease_token"]))

    def get_job(self, owner, job_id):
        with self.connection() as db:
            row = db.execute("SELECT * FROM jobs WHERE owner=? AND id=?", (owner, job_id)).fetchone()
            return dict(row) if row else None

    def jobs(self, owner):
        with self.connection() as db:
            return [dict(row) for row in db.execute(
                "SELECT * FROM jobs WHERE owner=? ORDER BY created_at DESC LIMIT 100", (owner,))]

    def memories(self, owner, ids=None):
        if ids is not None and not ids:
            return []
        with self.connection() as db:
            query = """SELECT m.* FROM memories m JOIN jobs j ON m.job_id=j.id
                WHERE m.owner=? AND j.status='ready'"""
            params = [owner]
            if ids is not None:
                query += " AND m.id IN (" + ",".join("?" for _ in ids) + ")"
                params.extend(ids)
            query += " ORDER BY j.created_at DESC"
            if ids is None:
                query += " LIMIT 100"
            rows = db.execute(query, params).fetchall()
            result = [dict(row) | {"tags": json.loads(row["tags"])} for row in rows]
            if ids is None:
                return result[:100]
            by_id = {row["id"]: row for row in result}
            return [by_id[item] for item in ids if item in by_id]
