"""Local SQLite sessions. Transactions contain storage work only, never model calls."""
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import math
import sqlite3
import threading
import uuid


_FIELDS = {"startedAt", "endedAt", "updatedAt", "entryType", "entryLabel", "title",
           "durationSeconds", "messageCount", "promptContext", "summaryMarkdown"}
_LIMITS = {"startedAt": 64, "endedAt": 64, "updatedAt": 64, "entryType": 100,
           "entryLabel": 200, "title": 200, "promptContext": 8000, "summaryMarkdown": 100000}


def _json(value):
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False)
    except (TypeError, ValueError, RecursionError):
        raise SessionError("Invalid session data", 400) from None


def _hash(value):
    return hashlib.sha256(_json(value).encode("utf-8")).hexdigest()


def _now():
    return datetime.now(timezone.utc).isoformat()


def _identifier(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 200:
        raise SessionError("Invalid identifier", 400)
    return value


def _content(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 8000:
        raise SessionError("Message must contain 1 to 8000 characters", 400)
    return value


def _metadata(value):
    if not isinstance(value, dict) or set(value) - _FIELDS:
        raise SessionError("Invalid session metadata", 400)
    for key, item in value.items():
        if key in ("durationSeconds", "messageCount"):
            if isinstance(item, bool) or not isinstance(item, (int, float)) or not math.isfinite(item) or item < 0:
                raise SessionError("Invalid session metadata", 400)
        elif key == "endedAt" and item is None:
            continue
        elif not isinstance(item, str) or len(item) > _LIMITS[key]:
            raise SessionError("Invalid session metadata", 400)
    return value.copy()


class SessionError(Exception):
    def __init__(self, message, status):
        super().__init__(message)
        self.status = status


class SessionStore:
    def __init__(self, path):
        self._lock = threading.RLock()
        self._db = sqlite3.connect(str(path), timeout=5, isolation_level=None, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA foreign_keys = ON")
        self._db.executescript("""
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0,
                deleted INTEGER NOT NULL DEFAULT 0, metadata TEXT NOT NULL,
                origin_hash TEXT NOT NULL, current_turn TEXT, pending_request_id TEXT,
                saved_snapshot TEXT, saved_revision INTEGER
            );
            CREATE TABLE IF NOT EXISTS messages (
                session_id TEXT NOT NULL REFERENCES sessions(id), id TEXT NOT NULL,
                position INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
                PRIMARY KEY(session_id, id), UNIQUE(session_id, position)
            );
            CREATE TABLE IF NOT EXISTS turns (
                session_id TEXT NOT NULL REFERENCES sessions(id), request_id TEXT NOT NULL,
                accepted_revision INTEGER NOT NULL, user_message_id TEXT NOT NULL,
                content_hash TEXT NOT NULL, retry_of TEXT, status TEXT NOT NULL,
                result_json TEXT, final_revision INTEGER,
                PRIMARY KEY(session_id, request_id)
            );
        """)

    @contextmanager
    def _transaction(self):
        with self._lock:
            self._db.execute("BEGIN IMMEDIATE")
            try:
                yield
                self._db.execute("COMMIT")
            except BaseException:
                self._db.execute("ROLLBACK")
                raise

    def _session(self, session_id):
        row = self._db.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
        if row is None or row["deleted"]:
            raise SessionError("Session not found", 404)
        return row

    def _turn(self, session_id, request_id):
        row = self._db.execute("SELECT * FROM turns WHERE session_id = ? AND request_id = ?", (session_id, request_id)).fetchone()
        if row is None:
            raise SessionError("Turn not found", 404)
        return row

    @staticmethod
    def _revision(row, expected):
        if isinstance(expected, bool) or not isinstance(expected, int) or row["revision"] != expected:
            raise SessionError("Session revision conflict", 409)

    @staticmethod
    def _idle(row):
        if row["pending_request_id"] is not None:
            raise SessionError("Session has a pending turn", 409)

    def _messages(self, session_id):
        return [dict(row) for row in self._db.execute("SELECT id, role, content FROM messages WHERE session_id = ? ORDER BY position", (session_id,))]

    @staticmethod
    def _public_turn(row):
        value = {"request_id": row["request_id"], "status": row["status"],
                 "user_message_id": row["user_message_id"],
                 "revision": row["final_revision"] if row["final_revision"] is not None else row["accepted_revision"]}
        if row["status"] == "completed":
            value["reply"] = json.loads(row["result_json"])["reply"]
        return value

    def _public_session(self, row):
        messages = self._messages(row["id"])
        last = self._db.execute("SELECT * FROM turns WHERE session_id = ? AND status != 'discarded' ORDER BY accepted_revision DESC LIMIT 1", (row["id"],)).fetchone()
        return {**json.loads(row["metadata"]), "id": row["id"], "messages": messages,
                "messageCount": sum(m["role"] == "user" for m in messages),
                "revision": row["revision"], "storage": "server",
                "saved": row["saved_revision"] == row["revision"],
                "hasSavedSnapshot": row["saved_snapshot"] is not None,
                "pendingRequestId": row["pending_request_id"],
                "lastTurn": self._public_turn(last) if last else None}

    def _state(self, row):
        if not row["current_turn"]:
            return None
        turn = self._turn(row["id"], row["current_turn"])
        return json.loads(turn["result_json"])["session_state"] if turn["result_json"] else None

    def _insert_messages(self, session_id, messages, start=0):
        self._db.executemany("INSERT INTO messages (session_id, id, position, role, content) VALUES (?, ?, ?, ?, ?)",
                             [(session_id, m["id"], start + i, m["role"], m["content"]) for i, m in enumerate(messages)])

    def create(self, session, *, imported=False):
        if not isinstance(session, dict) or set(session) - (_FIELDS | {"id", "messages"}):
            raise SessionError("Invalid session", 400)
        sid = _identifier(session.get("id"))
        fields = _metadata({k: v for k, v in session.items() if k in _FIELDS})
        raw_messages = session.get("messages", [])
        if not isinstance(raw_messages, list) or (raw_messages and not imported):
            raise SessionError("Messages require explicit import", 400)
        if len(raw_messages) + bool(fields.get("promptContext")) > 60:
            raise SessionError("Session exceeds message limit", 400)
        messages, ids = [], set()
        for item in raw_messages:
            if not isinstance(item, dict) or set(item) - {"id", "role", "content"} or item.get("role") not in ("user", "assistant"):
                raise SessionError("Invalid imported message", 400)
            mid = _identifier(item["id"]) if "id" in item else str(uuid.uuid4())
            if mid in ids:
                raise SessionError("Duplicate message identifier", 400)
            ids.add(mid)
            messages.append({"id": mid, "role": item["role"], "content": _content(item.get("content"))})
        origin_hash = _hash({"session": session, "imported": imported})
        now = _now()
        metadata = {"startedAt": now, "endedAt": None, "updatedAt": now,
                    "entryType": "free_conversation", "entryLabel": "开始探索", "title": "开始探索",
                    "durationSeconds": 0, "messageCount": 0, "promptContext": "", "summaryMarkdown": "", **fields}
        with self._transaction():
            existing = self._db.execute("SELECT * FROM sessions WHERE id = ?", (sid,)).fetchone()
            if existing:
                if existing["deleted"] or existing["origin_hash"] != origin_hash:
                    raise SessionError("Session identifier conflict", 409)
                return self._public_session(existing)
            self._db.execute("INSERT INTO sessions (id, metadata, origin_hash) VALUES (?, ?, ?)", (sid, _json(metadata), origin_hash))
            self._insert_messages(sid, messages)
            if imported:
                snapshot = {"metadata": metadata, "messages": messages, "current_turn": None, "revision": 0}
                self._db.execute("UPDATE sessions SET saved_snapshot = ?, saved_revision = 0 WHERE id = ?", (_json(snapshot), sid))
            return self._public_session(self._session(sid))

    def get(self, session_id):
        with self._transaction():
            return self._public_session(self._session(session_id))

    def list(self):
        with self._transaction():
            return [self._public_session(row) for row in self._db.execute("SELECT * FROM sessions WHERE deleted = 0 ORDER BY rowid DESC").fetchall()]

    def begin_turn(self, session_id, request_id, expected_revision, message, *, retry_of=None):
        _identifier(request_id)
        _content(message)
        if retry_of is not None:
            _identifier(retry_of)
        content_hash = _hash(message)
        with self._transaction():
            row = self._session(session_id)
            existing = self._db.execute("SELECT * FROM turns WHERE session_id = ? AND request_id = ?", (session_id, request_id)).fetchone()
            if existing:
                if existing["status"] == "discarded" or existing["content_hash"] != content_hash or existing["retry_of"] != retry_of:
                    raise SessionError("Request identifier conflict", 409)
                return self._accepted(row, existing, False)
            self._revision(row, expected_revision)
            self._idle(row)
            messages = self._messages(session_id)
            mid = str(uuid.uuid4())
            if retry_of is not None:
                previous = self._turn(session_id, retry_of)
                if previous["status"] not in ("failed", "interrupted") or previous["content_hash"] != content_hash:
                    raise SessionError("Turn cannot be retried", 409)
                mid = previous["user_message_id"]
                if not messages or messages[-1]["id"] != mid:
                    raise SessionError("Only the latest user message can be retried", 409)
            count = len(messages) + bool(json.loads(row["metadata"])["promptContext"]) + (1 if retry_of is not None else 2)
            if count > 60:
                raise SessionError("Session exceeds message limit", 400)
            accepted = row["revision"] + 1
            if retry_of is None:
                self._insert_messages(session_id, [{"id": mid, "role": "user", "content": message}], len(messages))
            self._db.execute("INSERT INTO turns (session_id, request_id, accepted_revision, user_message_id, content_hash, retry_of, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')",
                             (session_id, request_id, accepted, mid, content_hash, retry_of))
            self._db.execute("UPDATE sessions SET revision = ?, pending_request_id = ? WHERE id = ?", (accepted, request_id, session_id))
            return self._accepted(self._session(session_id), self._turn(session_id, request_id), True)

    def _accepted(self, row, turn, created):
        return {"created": created, "turn": self._public_turn(turn), "session": self._public_session(row),
                "messages": self._messages(row["id"]), "internal_state": self._state(row),
                "accepted_revision": turn["accepted_revision"]}

    def complete_turn(self, session_id, request_id, accepted_revision, result):
        if not isinstance(result, dict) or not {"reply", "analysis", "dialogue", "session_state", "usage", "models", "prompt_version"} <= set(result):
            raise SessionError("Invalid turn result", 400)
        _content(result["reply"])
        encoded = _json(result)
        with self._transaction():
            row = self._session(session_id)
            turn = self._turn(session_id, request_id)
            self._revision(row, accepted_revision)
            if turn["status"] != "pending" or row["pending_request_id"] != request_id or turn["accepted_revision"] != accepted_revision:
                raise SessionError("Turn is no longer pending", 409)
            messages = self._messages(session_id)
            self._insert_messages(session_id, [{"id": str(uuid.uuid4()), "role": "assistant", "content": result["reply"]}], len(messages))
            revision = row["revision"] + 1
            self._db.execute("UPDATE turns SET status = 'completed', result_json = ?, final_revision = ? WHERE session_id = ? AND request_id = ?", (encoded, revision, session_id, request_id))
            self._db.execute("UPDATE sessions SET revision = ?, pending_request_id = NULL, current_turn = ? WHERE id = ?", (revision, request_id, session_id))
            return self._public_turn(self._turn(session_id, request_id))

    def fail_turn(self, session_id, request_id, status="failed"):
        if status not in ("failed", "interrupted"):
            raise SessionError("Invalid turn status", 400)
        with self._transaction():
            row = self._session(session_id)
            turn = self._turn(session_id, request_id)
            if turn["status"] != "pending":
                return self._public_turn(turn)
            revision = row["revision"] + 1
            self._db.execute("UPDATE turns SET status = ?, final_revision = ? WHERE session_id = ? AND request_id = ?", (status, revision, session_id, request_id))
            self._db.execute("UPDATE sessions SET revision = ?, pending_request_id = NULL WHERE id = ?", (revision, session_id))
            return self._public_turn(self._turn(session_id, request_id))

    def get_turn(self, session_id, request_id):
        with self._transaction():
            self._session(session_id)
            return self._public_turn(self._turn(session_id, request_id))

    def load_state(self, session_id):
        with self._transaction():
            return self._state(self._session(session_id))

    def _change_metadata(self, row, metadata):
        updated = {**json.loads(row["metadata"]), **_metadata(metadata), "updatedAt": _now()}
        # Context changes must preserve the same 60-entry input boundary.
        if len(self._messages(row["id"])) + bool(updated["promptContext"]) > 60:
            raise SessionError("Session exceeds message limit", 400)
        return updated

    def update_metadata(self, session_id, expected_revision, metadata):
        with self._transaction():
            row = self._session(session_id)
            self._revision(row, expected_revision)
            self._idle(row)
            updated = self._change_metadata(row, metadata)
            self._db.execute("UPDATE sessions SET metadata = ?, revision = revision + 1 WHERE id = ?", (_json(updated), session_id))
            return self._public_session(self._session(session_id))

    def save(self, session_id, expected_revision, metadata=None):
        with self._transaction():
            row = self._session(session_id)
            self._revision(row, expected_revision)
            self._idle(row)
            updated = self._change_metadata(row, metadata if metadata is not None else {})
            revision = row["revision"] + 1
            snapshot = {"metadata": updated, "messages": self._messages(session_id),
                        "current_turn": row["current_turn"], "revision": revision}
            self._db.execute("UPDATE sessions SET metadata = ?, revision = ?, saved_snapshot = ?, saved_revision = ? WHERE id = ?", (_json(updated), revision, _json(snapshot), revision, session_id))
            return self._public_session(self._session(session_id))

    def _tombstone(self, row):
        session_id = row["id"]
        revision = row["revision"] + 1
        self._db.execute("DELETE FROM messages WHERE session_id = ?", (session_id,))
        self._db.execute("DELETE FROM turns WHERE session_id = ?", (session_id,))
        self._db.execute("UPDATE sessions SET revision = ?, deleted = 1, metadata = '{}', current_turn = NULL, pending_request_id = NULL, saved_snapshot = NULL, saved_revision = NULL WHERE id = ?", (revision, session_id))
        return {"id": session_id, "revision": revision, "deleted": True}

    def discard(self, session_id, expected_revision):
        with self._transaction():
            row = self._session(session_id)
            self._revision(row, expected_revision)
            if row["saved_snapshot"] is None:
                return self._tombstone(row)
            snapshot = json.loads(row["saved_snapshot"])
            revision = row["revision"] + 1
            self._db.execute("DELETE FROM messages WHERE session_id = ?", (session_id,))
            self._insert_messages(session_id, snapshot["messages"])
            self._db.execute("UPDATE turns SET status = 'discarded', result_json = NULL, content_hash = '', final_revision = ? WHERE session_id = ? AND accepted_revision > ?", (revision, session_id, snapshot["revision"]))
            self._db.execute("UPDATE sessions SET revision = ?, metadata = ?, current_turn = ?, pending_request_id = NULL, saved_revision = ? WHERE id = ?", (revision, _json(snapshot["metadata"]), snapshot["current_turn"], revision, session_id))
            return self._public_session(self._session(session_id))

    def delete(self, session_id, expected_revision):
        with self._transaction():
            row = self._session(session_id)
            self._revision(row, expected_revision)
            return self._tombstone(row)

    def recover_pending(self):
        """Call once at application startup, never while another process is active."""
        with self._transaction():
            rows = self._db.execute("SELECT * FROM sessions WHERE deleted = 0 AND pending_request_id IS NOT NULL").fetchall()
            for row in rows:
                revision = row["revision"] + 1
                self._db.execute("UPDATE turns SET status = 'interrupted', final_revision = ? WHERE session_id = ? AND request_id = ? AND status = 'pending'", (revision, row["id"], row["pending_request_id"]))
                self._db.execute("UPDATE sessions SET revision = ?, pending_request_id = NULL WHERE id = ?", (revision, row["id"]))
            return len(rows)

    def close(self):
        with self._lock:
            self._db.close()
