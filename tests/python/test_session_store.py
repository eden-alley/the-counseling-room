"""SQLite lifecycle contracts: real storage, no model or network doubles."""
import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor

import pytest

from backend.session_store import SessionError, SessionStore


def session(sid="s1", **extra):
    return {"id": sid, "title": "开始探索", "promptContext": "入口说明", **extra}


def result(reply="听到了", **extra):
    return {"reply": reply, "analysis": {"private": "理解"},
            "dialogue": {"private": "反馈"}, "session_state": {"topic": "工作"},
            "usage": {}, "models": {}, "prompt_version": "v1", **extra}


def conflict(fn, status=409):
    with pytest.raises(SessionError) as caught:
        fn()
    assert caught.value.status == status


@pytest.fixture
def store():
    value = SessionStore(":memory:")
    yield value
    value.close()


def test_completed_turn_survives_reopen_and_public_views_exclude_internal_state(tmp_path):
    path = tmp_path / "sessions.db"
    first = SessionStore(path)
    created = first.create(session())
    assert created["messages"] == [] and created["storage"] == "server"
    accepted = first.begin_turn("s1", "r1", created["revision"], "原文")
    assert accepted["messages"] == [{"id": accepted["turn"]["user_message_id"], "role": "user", "content": "原文"}]
    finished = first.complete_turn("s1", "r1", accepted["accepted_revision"], result())
    first.close()
    second = SessionStore(path)
    assert second.get_turn("s1", "r1") == finished
    assert second.load_state("s1") == {"topic": "工作"}
    public = second.get("s1")
    assert [m["content"] for m in public["messages"]] == ["原文", "听到了"]
    assert "private" not in json.dumps([public, second.list(), finished])
    assert public["pendingRequestId"] is None and public["lastTurn"] == finished
    second.close()


def test_duplicate_turn_precedes_revision_check_but_changed_message_conflicts(store):
    initial = store.create(session())
    a = store.begin_turn("s1", "r1", initial["revision"], "你好")
    again = store.begin_turn("s1", "r1", -1, "你好")
    assert again["created"] is False and again["turn"] == a["turn"]
    conflict(lambda: store.begin_turn("s1", "r1", -1, "改写"))
    done = store.complete_turn("s1", "r1", a["accepted_revision"], result())
    assert store.begin_turn("s1", "r1", 0, "你好")["turn"] == done
    assert len(store.get("s1")["messages"]) == 2


def test_saved_snapshot_remains_discoverable_while_current_revision_is_unsaved(store):
    original = store.create(session())
    assert original['saved'] is False and original['hasSavedSnapshot'] is False
    saved = store.save('s1', original['revision'])
    store.begin_turn('s1', 'r1', saved['revision'], '续聊原文')
    current = store.list()[0]
    assert current['saved'] is False and current['hasSavedSnapshot'] is True
    restored = store.discard('s1', current['revision'])
    assert restored['saved'] is True and restored['hasSavedSnapshot'] is True


def test_pending_serializes_same_session_but_other_session_is_independent(store):
    store.create(session())
    store.create(session("s2"))
    store.begin_turn("s1", "r1", 0, "一")
    conflict(lambda: store.begin_turn("s1", "r2", 1, "二"))
    assert store.begin_turn("s2", "r1", 0, "另一段")["created"] is True
    store.delete("s2", 1)
    assert store.get_turn("s1", "r1")["status"] == "pending"


def test_two_connections_cannot_accept_concurrent_turns(tmp_path):
    path = tmp_path / "concurrent.db"
    first, second = SessionStore(path), SessionStore(path)
    first.create(session())
    def accept(pair):
        value, rid = pair
        try:
            value.begin_turn("s1", rid, 0, rid)
            return "accepted"
        except SessionError as exc:
            return exc.status
    with ThreadPoolExecutor(2) as executor:
        assert sorted(executor.map(accept, [(first, "a"), (second, "b")]), key=str) == [409, "accepted"]
    first.close()
    second.close()


def test_completion_database_failure_rolls_back_reply_and_state(tmp_path):
    path = tmp_path / "rollback.db"
    value = SessionStore(path)
    value.create(session())
    a = value.begin_turn("s1", "r1", 0, "原文")
    with sqlite3.connect(path) as db:
        db.execute("CREATE TRIGGER reject_reply BEFORE INSERT ON messages WHEN NEW.role = 'assistant' BEGIN SELECT RAISE(ABORT, 'test'); END")
    with pytest.raises(sqlite3.DatabaseError):
        value.complete_turn("s1", "r1", a["accepted_revision"], result())
    assert value.load_state("s1") is None
    assert value.get_turn("s1", "r1")["status"] == "pending"
    assert [m["content"] for m in value.get("s1")["messages"]] == ["原文"]
    value.close()


def test_recovery_is_explicit_and_preserves_user_original(tmp_path):
    path = tmp_path / "recover.db"
    first = SessionStore(path)
    first.create(session())
    first.begin_turn("s1", "r1", 0, "原文")
    second = SessionStore(path)
    assert second.get_turn("s1", "r1")["status"] == "pending"
    second.recover_pending()
    assert first.get_turn("s1", "r1")["status"] == "interrupted"
    assert first.get("s1")["messages"][0]["content"] == "原文"
    assert first.load_state("s1") is None
    conflict(lambda: first.complete_turn("s1", "r1", 1, result()))
    first.close()
    second.close()


def test_save_and_metadata_require_explicit_cancel_and_late_completion_cannot_overwrite(store):
    store.create(session())
    a = store.begin_turn("s1", "r1", 0, "保留这句话")
    conflict(lambda: store.save("s1", a["accepted_revision"], {"title": "保存标题"}))
    conflict(lambda: store.update_metadata("s1", a["accepted_revision"], {"title": "保存标题"}))
    store.fail_turn("s1", "r1", "interrupted")
    saved = store.save("s1", store.get("s1")["revision"], {"title": "保存标题"})
    assert saved["saved"] is True and saved["pendingRequestId"] is None
    assert store.get_turn("s1", "r1")["status"] == "interrupted"
    conflict(lambda: store.complete_turn("s1", "r1", a["accepted_revision"], result()))
    assert store.get("s1")["title"] == "保存标题"


def test_discard_restores_saved_state_as_new_revision_and_scrubs_later_content(tmp_path):
    path = tmp_path / "discard.db"
    value = SessionStore(path)
    value.create(session())
    a = value.begin_turn("s1", "r1", 0, "保存的原文")
    value.complete_turn("s1", "r1", a["accepted_revision"], result("保存的回复"))
    saved = value.save("s1", value.get("s1")["revision"])
    b = value.begin_turn("s1", "r2", saved["revision"], "待丢弃原文")
    value.complete_turn("s1", "r2", b["accepted_revision"], result("待丢弃回复", analysis={"secret": "待丢弃理解"}))
    before = value.get("s1")["revision"]
    restored = value.discard("s1", before)
    assert restored["revision"] > before
    assert [m["content"] for m in restored["messages"]] == ["保存的原文", "保存的回复"]
    assert value.load_state("s1") == {"topic": "工作"}
    assert value.get_turn("s1", "r2")["status"] == "discarded"
    conflict(lambda: value.complete_turn("s1", "r2", b["accepted_revision"], result()))
    conflict(lambda: value.begin_turn("s1", "r2", restored["revision"], "待丢弃原文"))
    with sqlite3.connect(path) as db:
        raw = json.dumps([list(db.execute("SELECT * FROM " + table)) for table in ("sessions", "messages", "turns")], ensure_ascii=False)
    assert "待丢弃原文" not in raw and "待丢弃回复" not in raw and "待丢弃理解" not in raw
    value.close()


def test_unsaved_discard_and_delete_leave_tombstones_and_isolate_sessions(store):
    store.create(session())
    store.create(session("s2"))
    dropped = store.discard("s1", 0)
    assert dropped["deleted"] is True
    conflict(lambda: store.get("s1"), 404)
    conflict(lambda: store.create(session()))
    assert [item["id"] for item in store.list()] == ["s2"]
    store.delete("s2", 0)
    conflict(lambda: store.create(session("s2"), imported=True))


def test_import_idempotence_uses_original_content_even_after_session_changes(store):
    legacy = session(messages=[{"role": "assistant", "content": "开场"}, {"role": "user", "content": "旧原文"}])
    first = store.create(legacy, imported=True)
    assert first["messages"][1]["content"] == "旧原文"
    changed = store.update_metadata("s1", 0, {"title": "新标题"})
    assert store.create(legacy, imported=True) == changed
    conflict(lambda: store.create({**legacy, "title": "不同原始标题"}, imported=True))
    assert len(store.get("s1")["messages"]) == 2


@pytest.mark.parametrize("finish_draft", [False, True])
def test_import_is_saved_and_discard_restores_original_history_then_can_resume(store, finish_draft):
    original = session(messages=[{"role": "user", "content": "原有记录"}, {"role": "assistant", "content": "原有回复"}])
    imported = store.create(original, imported=True)
    assert imported["saved"] is True
    assert store.load_state("s1") is None
    draft = store.begin_turn("s1", "draft", imported["revision"], "草稿原文")
    if finish_draft:
        store.complete_turn("s1", "draft", draft["accepted_revision"], result())
    restored = store.discard("s1", store.get("s1")["revision"])
    assert [m["content"] for m in restored["messages"]] == ["原有记录", "原有回复"]
    assert restored["saved"] is True and store.load_state("s1") is None
    assert original["messages"] == [{"role": "user", "content": "原有记录"}, {"role": "assistant", "content": "原有回复"}]
    resumed = store.begin_turn("s1", "resume", restored["revision"], "继续")
    assert resumed["created"] is True and resumed["internal_state"] is None


def test_begin_next_turn_receives_only_previous_session_state(store):
    store.create(session())
    first = store.begin_turn("s1", "first", 0, "原文")
    completed = store.complete_turn("s1", "first", first["accepted_revision"], result())
    next_turn = store.begin_turn("s1", "next", completed["revision"], "继续")
    assert next_turn["internal_state"] == {"topic": "工作"}


@pytest.mark.parametrize("changes", [
    {"messages": [{"role": "user", "content": "x" * 8001}]},
    {"messages": [{"role": "system", "content": "上下文冒充发言"}]},
    {"messages": [{"role": "user", "content": "x"}] * 60},
    {"messages": [{"id": "same", "role": "user", "content": "a"}, {"id": "same", "role": "assistant", "content": "b"}]},
    {"promptContext": "x" * 8001}, {"analysis": {}}, {"title": "x" * 201}, {"startedAt": "x" * 65},
])
def test_import_rejects_invalid_material_without_truncation_or_partial_session(store, changes):
    conflict(lambda: store.create(session(**changes), imported=True), 400)
    assert store.list() == []


def test_context_and_reserved_assistant_slot_count_toward_message_limit(store):
    old = [{"role": "user", "content": "原文"}] * 57
    initial = store.create(session(messages=old), imported=True)
    accepted = store.begin_turn("s1", "last", initial["revision"], "最后一条")
    store.complete_turn("s1", "last", accepted["accepted_revision"], result())
    conflict(lambda: store.begin_turn("s1", "too-many", store.get("s1")["revision"], "超额"), 400)
    assert len(store.get("s1")["messages"]) == 59


def test_failed_turn_retry_reuses_original_message_and_rejects_changed_retry(store):
    store.create(session())
    a = store.begin_turn("s1", "r1", 0, "原文")
    failed = store.fail_turn("s1", "r1")
    assert failed["status"] == "failed"
    rev = store.get("s1")["revision"]
    conflict(lambda: store.begin_turn("s1", "bad", rev, "改写", retry_of="r1"))
    retry = store.begin_turn("s1", "r2", rev, "原文", retry_of="r1")
    assert retry["turn"]["user_message_id"] == a["turn"]["user_message_id"]
    assert len(retry["messages"]) == 1


def test_metadata_rejects_private_and_reserved_fields_and_stale_revisions(store):
    store.create(session())
    for metadata in ({"messages": []}, {"analysis": {}}, {"revision": 90}, {"storage": "local"}, {"id": "s2"}):
        conflict(lambda: store.update_metadata("s1", 0, metadata), 400)
    updated = store.update_metadata("s1", 0, {"summaryMarkdown": "总结", "endedAt": "2026-10-27"})
    assert updated["summaryMarkdown"] == "总结"
    conflict(lambda: store.save("s1", 0))
    conflict(lambda: store.delete("s1", 0))
    assert store.get("s1") == updated
