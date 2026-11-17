"""Session protocol: real graph/store with offline role clients only."""
import asyncio
import json
from contextlib import asynccontextmanager
from dataclasses import replace

import httpx
import pytest

from backend.api import create_app
from backend.config import load_settings
from backend.session_store import SessionStore


class Role:
    configured = True
    provider = 'fixture'
    model = 'fixture-model'

    def __init__(self, role, *, gate=None, late=False, invalid=False):
        self.role, self.gate, self.late, self.invalid = role, gate, late, invalid
        self.started, self.cancelled = asyncio.Event(), asyncio.Event()
        self.calls, self.closed = 0, 0

    async def complete_once(self, messages, tools, max_completion_tokens, allow_tools, *, budget):
        self.calls += 1
        self.started.set()
        if self.gate is not None:
            try:
                await self.gate.wait()
            except asyncio.CancelledError:
                self.cancelled.set()
                if not self.late:
                    raise
        value = ({'goal': None, 'statements': [], 'hypotheses': [], 'boundaries': [],
                  'unknowns': [], 'exploration': None} if self.role == 'analysis' else
                 {'reply': '我在听，你可以慢慢说。', 'action': 'acknowledge', 'questions': [],
                  'analysis_response': 'deferred', 'feedback': 'private-feedback', 'evidence': []})
        return ({'message': {'content': 'invalid-private-provider' if self.invalid else json.dumps(value, ensure_ascii=False),
                             'tool_calls': None}, 'finish_reason': 'stop'}, {})

    async def aclose(self):
        self.closed += 1


@asynccontextmanager
async def fixture(*, first=None, second=None, store=None, configured=True):
    first, second = first or Role('analysis'), second or Role('dialogue')
    first.configured = configured
    storage = store or SessionStore(':memory:')
    app = create_app(settings=load_settings({}), session_store=storage,
                     role_clients={'analysis': first, 'dialogue': second})
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://127.0.0.1') as client:
            yield client, app, storage, first, second
    if store is None:
        storage.close()


async def create(client, sid='s1', **fields):
    response = await client.post('/api/sessions', json={'session': {'id': sid, **fields}})
    assert response.status_code == 200, response.text
    return response.json()['session']


def payload(revision=0, request_id='r1', **fields):
    return {'request_id': request_id, 'expected_revision': revision, 'message': '最近有点累。', **fields}


def events(response):
    return [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]


async def test_json_and_stream_commit_before_public_text_and_never_expose_internal_state():
    async with fixture() as (client, app, store, first, second):
        await create(client, promptContext='entry-context')
        response = await client.post('/api/sessions/s1/turns', json=payload(stream=True))
        data = events(response)
        assert [event['type'] for event in data] == ['accepted', 'delta', 'done']
        assert data[0]['session']['messages'][-1]['role'] == 'user'
        assert data[0]['revision'] == 1 and data[-1]['revision'] == 2
        assert data[-1]['session'] == store.get('s1')
        assert store.load_state('s1') is not None
        assert data[1] == {'type': 'delta', 'text': data[-1]['reply']}
        assert not {'analysis', 'dialogue', 'session_state', 'usage', 'models', 'prompt_version', 'internal_state'} & set(data[-1])
        assert 'private-feedback' not in response.text
        assert first.calls == second.calls == 1
        query = (await client.get('/api/sessions/s1/turns/r1')).json()
        assert query['turn']['status'] == 'completed'
        assert query['turn']['reply'] == data[-1]['reply']
        assert 'private-feedback' not in json.dumps(query)


async def test_duplicate_completed_request_is_idempotent_and_mismatched_payload_conflicts():
    async with fixture() as (client, app, store, first, second):
        await create(client)
        result = await client.post('/api/sessions/s1/turns', json=payload())
        duplicate = await client.post('/api/sessions/s1/turns', json=payload())
        assert result.status_code == duplicate.status_code == 200
        assert result.json() == duplicate.json()
        assert len(store.get('s1')['messages']) == 2
        assert first.calls == second.calls == 1
        assert (await client.post('/api/sessions/s1/turns', json=payload(message='different'))).status_code == 409


async def test_completed_replay_survives_missing_model_configuration_without_new_call():
    async with fixture() as (client, app, store, first, second):
        await create(client)
        original = await client.post('/api/sessions/s1/turns', json=payload())
        first.configured = False
        repeated = await client.post('/api/sessions/s1/turns', json=payload())
        assert repeated.status_code == 200 and repeated.json() == original.json()
        assert first.calls == second.calls == 1
        assert (await client.post('/api/sessions/s1/turns', json=payload(message='changed'))).status_code == 409
        assert (await client.post('/api/sessions/s1/turns', json=payload(2, 'new'))).status_code == 503
        assert len(store.get('s1')['messages']) == 2


async def test_duplicate_pending_joins_task_and_other_turn_conflicts():
    gate, first = asyncio.Event(), Role('analysis')
    first.gate = gate
    async with fixture(first=first) as (client, app, store, first, second):
        await create(client)
        one = asyncio.create_task(client.post('/api/sessions/s1/turns', json=payload()))
        await asyncio.wait_for(first.started.wait(), 2)
        two = asyncio.create_task(client.post('/api/sessions/s1/turns', json=payload()))
        conflict = await client.post('/api/sessions/s1/turns', json=payload(1, 'r2'))
        assert conflict.status_code == 409
        gate.set()
        a, b = await asyncio.gather(one, two)
        assert a.json() == b.json() and first.calls == second.calls == 1


async def test_pending_turn_cannot_be_saved_and_stale_mutations_are_rejected():
    first = Role('analysis', gate=asyncio.Event())
    async with fixture(first=first) as (client, app, store, first, second):
        await create(client)
        sending = asyncio.create_task(client.post('/api/sessions/s1/turns', json=payload()))
        await asyncio.wait_for(first.started.wait(), 2)
        assert (await client.post('/api/sessions/s1/save', json={'expected_revision': 1})).status_code == 409
        assert (await client.post('/api/sessions/s1/discard', json={'expected_revision': 0})).status_code == 409
        assert (await client.request('DELETE', '/api/sessions/s1', json={'expected_revision': 0})).status_code == 409
        cancelled = await client.post('/api/sessions/s1/turns/r1/cancel')
        revision = cancelled.json()['session']['revision']
        assert (await client.post('/api/sessions/s1/save', json={'expected_revision': revision})).status_code == 200
        await asyncio.gather(sending, return_exceptions=True)
        assert len(store.get('s1')['messages']) == 1 and store.get('s1')['saved'] is True


@pytest.mark.parametrize('late', [False, True])
async def test_cancel_invalidates_completion_before_stopping_task(late):
    first = Role('analysis', gate=asyncio.Event(), late=late)
    async with fixture(first=first) as (client, app, store, first, second):
        await create(client)
        sending = asyncio.create_task(client.post('/api/sessions/s1/turns', json=payload()))
        await asyncio.wait_for(first.started.wait(), 2)
        response = await client.post('/api/sessions/s1/turns/r1/cancel')
        assert response.status_code == 200
        assert response.json()['turn']['status'] == 'interrupted'
        await asyncio.wait_for(asyncio.gather(sending, return_exceptions=True), 2)
        assert store.get_turn('s1', 'r1')['status'] == 'interrupted'
        assert len(store.get('s1')['messages']) == 1
        assert store.load_state('s1') is None
        assert first.cancelled.is_set()


async def test_invalid_runtime_does_not_commit_half_state_and_repeat_does_not_regenerate():
    async with fixture(first=Role('analysis', invalid=True)) as (client, app, store, first, second):
        await create(client)
        response = await client.post('/api/sessions/s1/turns', json=payload(stream=True))
        data = events(response)
        assert [event['type'] for event in data] == ['accepted', 'error']
        assert 'private-provider' not in response.text
        assert store.load_state('s1') is None and len(store.get('s1')['messages']) == 1
        assert store.get_turn('s1', 'r1')['status'] == 'failed'
        await client.post('/api/sessions/s1/turns', json=payload())
        assert first.calls == 1 and second.calls == 0


async def test_failed_turn_keeps_previous_internal_state_and_explicit_retry_reuses_original_message():
    async with fixture() as (client, app, store, first, second):
        await create(client)
        assert (await client.post('/api/sessions/s1/turns', json=payload())).status_code == 200
        state = store.load_state('s1')
        first.invalid = True
        assert (await client.post('/api/sessions/s1/turns', json=payload(2, 'r2'))).status_code == 502
        assert store.load_state('s1') == state
        first.invalid = False
        response = await client.post('/api/sessions/s1/turns', json=payload(4, 'r3', retry_of='r2'))
        assert response.status_code == 200
        assert len(response.json()['session']['messages']) == 4
        assert [message['role'] for message in store.get('s1')['messages']] == ['user', 'assistant', 'user', 'assistant']


async def test_chat_uses_both_roles_while_report_keeps_legacy_complete_interface():
    class Reports:
        configured = True
        calls = 0
        async def complete(self, messages, **options):
            self.calls += 1
            return {'reply': '# public report'}
    legacy = Reports()
    roles = {'analysis': Role('analysis'), 'dialogue': Role('dialogue')}
    store = SessionStore(':memory:')
    app = create_app(settings=load_settings({}), model_client=legacy, role_clients=roles, session_store=store)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://127.0.0.1') as client:
            body = {'messages': [{'role': 'user', 'content': 'hello'}]}
            result = await client.post('/api/chat', json=body)
            assert result.json() == {'reply': '我在听，你可以慢慢说。'}
            assert [role.calls for role in roles.values()] == [1, 1]
            assert legacy.calls == 0
            assert (await client.post('/api/report/generate', json=body)).json() == {'report': '# public report'}
            assert legacy.calls == 1
    store.close()


async def test_unconfigured_model_preserves_read_apis_but_does_not_accept_user_message():
    async with fixture(configured=False) as (client, app, store, first, second):
        await create(client)
        assert (await client.get('/api/health')).json() == {'ready': False, 'capabilities': {'sessions_v1': True}}
        assert (await client.get('/api/sessions/s1')).status_code == 200
        assert (await client.get('/api/sessions')).json()['sessions'][0]['id'] == 's1'
        assert (await client.post('/api/sessions/s1/turns', json=payload())).status_code == 503
        assert store.get('s1')['messages'] == [] and first.calls == 0


@pytest.mark.parametrize('headers', [
    {'host': 'evil.example'}, {'host': '127.0.0.1.evil.example'}, {'host': 'localhost@evil.example'},
    {'origin': 'https://evil.example'}, {'origin': 'null'}, {'origin': 'file://localhost'},
    {'origin': 'http://localhost.evil.example'}, {'origin': 'http://localhost/path'},
])
async def test_all_session_methods_reject_nonlocal_host_or_origin(headers):
    async with fixture() as (client, app, store, first, second):
        await create(client)
        routes = [('GET', '/api/sessions'), ('GET', '/api/sessions/s1'),
                  ('POST', '/api/sessions'), ('POST', '/api/sessions/import'),
                  ('POST', '/api/sessions/s1/turns'), ('GET', '/api/sessions/s1/turns/r1'),
                  ('POST', '/api/sessions/s1/turns/r1/cancel'), ('POST', '/api/sessions/s1/save'),
                  ('POST', '/api/sessions/s1/discard'), ('POST', '/api/sessions/s1/metadata'),
                  ('DELETE', '/api/sessions/s1'), ('OPTIONS', '/api/sessions')]
        for method, path in routes:
            response = await client.request(method, path, headers=headers)
            assert response.status_code == 403, (method, path, response.text)
        assert store.get('s1')['revision'] == 0


async def test_local_origin_uses_explicit_cors_and_ipv6_loopback_is_allowed():
    async with fixture() as (client, app, store, first, second):
        for host in ['localhost:9018', '127.0.0.1:9018', '[::1]:9018']:
            response = await client.get('/api/sessions', headers={'host': host, 'origin': 'http://localhost:4173'})
            assert response.status_code == 200
            assert response.headers['access-control-allow-origin'] == 'http://localhost:4173'
        response = await client.options('/api/sessions', headers={'origin': 'http://127.0.0.1:4173', 'access-control-request-method': 'DELETE'})
        assert response.status_code == 200
        assert response.headers['access-control-allow-origin'] != '*'


async def test_strict_bounded_bodies_save_discard_metadata_import_and_tombstone():
    async with fixture() as (client, app, store, first, second):
        await create(client)
        for bad in [payload(extra=True), payload(expected_revision=True), payload(message=''), payload(stream='yes')]:
            assert (await client.post('/api/sessions/s1/turns', json=bad)).status_code == 400
        assert (await client.post('/api/sessions', content=b'x' * 160001)).status_code == 413
        assert (await client.post('/api/sessions/s1/save', json={'expected_revision': 0, 'extra': True})).status_code == 400
        saved = (await client.post('/api/sessions/s1/save', json={'expected_revision': 0})).json()['session']
        assert saved['saved'] is True
        changed = (await client.post('/api/sessions/s1/metadata', json={'expected_revision': 1, 'metadata': {'title': 'new'}})).json()['session']
        assert changed['title'] == 'new'
        assert (await client.post('/api/sessions/s1/save', json={'expected_revision': 1})).status_code == 409
        discarded = (await client.post('/api/sessions/s1/discard', json={'expected_revision': 2})).json()['session']
        assert discarded['title'] != 'new'
        tombstone = (await client.request('DELETE', '/api/sessions/s1', json={'expected_revision': 3})).json()['session']
        assert tombstone == {'id': 's1', 'revision': 4, 'deleted': True}
        await create(client, 'new')
        assert (await client.post('/api/sessions/new/discard', json={'expected_revision': 0})).json()['session']['deleted'] is True
        old = {'id': 'old', 'promptContext': 'context only', 'messages': [{'role': 'user', 'content': 'raw'}]}
        imported = await client.post('/api/sessions/import', json={'session': old})
        assert imported.status_code == 200
        assert imported.json() == (await client.post('/api/sessions/import', json={'session': old})).json()
        assert (await client.post('/api/sessions', json={'session': old})).status_code == 400
        assert (await client.post('/api/sessions/old/turns/nope/cancel', json={'unexpected': True})).status_code == 400
        assert (await client.post('/api/sessions/old/turns/nope/cancel', content=b'x' * 160001)).status_code == 413


async def test_storage_exception_is_safe_and_does_not_return_sql_or_provider_text():
    class BrokenStore(SessionStore):
        def get(self, sid):
            raise RuntimeError('SELECT private-body FROM secret-table')
    store = BrokenStore(':memory:')
    async with fixture(store=store) as (client, app, store, first, second):
        response = await client.get('/api/sessions/s1')
        assert response.status_code == 500
        assert 'private-body' not in response.text and 'SELECT' not in response.text
    store.close()


async def test_injected_store_is_not_recovered_or_closed_and_shutdown_interrupts_active_task():
    store = SessionStore(':memory:')
    store.create({'id': 'orphan'})
    store.begin_turn('orphan', 'r0', 0, 'original')
    first = Role('analysis', gate=asyncio.Event())
    sending = None
    async with fixture(first=first, store=store) as (client, app, store, first, second):
        assert store.get_turn('orphan', 'r0')['status'] == 'pending'
        response = await client.post('/api/sessions/orphan/turns', json=payload(request_id='r0', message='original'))
        assert response.status_code == 202 and first.calls == 0
        await create(client)
        sending = asyncio.create_task(client.post('/api/sessions/s1/turns', json=payload()))
        await asyncio.wait_for(first.started.wait(), 2)
    await asyncio.gather(sending, return_exceptions=True)
    assert store.get_turn('s1', 'r1')['status'] == 'interrupted'
    assert first.closed == second.closed == 0
    store.close()


async def drive_stream(app, *, disconnect_on, check=None):
    """ASGI-only disconnect probe; no listening socket or external network."""
    incoming = asyncio.Queue()
    await incoming.put({'type': 'http.request', 'body': json.dumps(payload(stream=True)).encode(), 'more_body': False})
    output = []

    async def send(message):
        output.append(message)
        if check:
            check(message)
        if message['type'] == 'http.response.body' and disconnect_on.encode() in message.get('body', b''):
            await incoming.put({'type': 'http.disconnect'})

    scope = {'type': 'http', 'asgi': {'version': '3.0', 'spec_version': '2.0'},
             'http_version': '1.1', 'method': 'POST', 'scheme': 'http', 'path': '/api/sessions/s1/turns',
             'raw_path': b'/api/sessions/s1/turns', 'query_string': b'',
             'headers': [(b'host', b'127.0.0.1'), (b'content-type', b'application/json')],
             'client': ('127.0.0.1', 1000), 'server': ('127.0.0.1', 80), 'root_path': ''}
    await asyncio.wait_for(app(scope, incoming.get, send), 3)
    return output


@pytest.mark.parametrize('committed', [False, True])
async def test_disconnect_interrupts_pending_but_committed_result_is_queryable_without_regeneration(committed):
    first = Role('analysis', gate=None if committed else asyncio.Event())
    async with fixture(first=first) as (client, app, store, first, second):
        await create(client)
        def check(message):
            if b'event: delta' in message.get('body', b''):
                assert store.get_turn('s1', 'r1')['status'] == 'completed'
                assert store.load_state('s1') is not None
        await drive_stream(app, disconnect_on='event: delta' if committed else 'event: accepted', check=check)
        query = (await client.get('/api/sessions/s1/turns/r1')).json()
        assert query['turn']['status'] == ('completed' if committed else 'interrupted')
        calls = first.calls
        await client.get('/api/sessions/s1/turns/r1')
        assert first.calls == calls


async def test_nonstream_disconnect_event_interrupts_in_progress_role():
    first = Role('analysis', gate=asyncio.Event())
    async with fixture(first=first) as (client, app, store, first, second):
        await create(client)
        incoming = asyncio.Queue()
        await incoming.put({'type': 'http.request', 'body': json.dumps(payload()).encode(), 'more_body': False})
        scope = {'type': 'http', 'asgi': {'version': '3.0', 'spec_version': '2.0'},
                 'http_version': '1.1', 'method': 'POST', 'scheme': 'http', 'path': '/api/sessions/s1/turns',
                 'raw_path': b'/api/sessions/s1/turns', 'query_string': b'',
                 'headers': [(b'host', b'127.0.0.1'), (b'content-type', b'application/json')],
                 'client': ('127.0.0.1', 1000), 'server': ('127.0.0.1', 80), 'root_path': ''}
        async def send(message):
            pass
        sending = asyncio.create_task(app(scope, incoming.get, send))
        await asyncio.wait_for(first.started.wait(), 2)
        await incoming.put({'type': 'http.disconnect'})
        await asyncio.wait_for(asyncio.gather(sending, return_exceptions=True), 2)
        assert first.cancelled.is_set()
        assert store.get_turn('s1', 'r1')['status'] == 'interrupted'
        assert len(store.get('s1')['messages']) == 1


async def test_default_owned_store_recovers_once_and_owned_clients_close(monkeypatch):
    import backend.agent.runtime as runtime
    import backend.session_api as session_api
    class TrackingStore(SessionStore):
        def __init__(self, path):
            super().__init__(path)
            self.recoveries, self.closes = 0, 0
            self.create({'id': 'old'})
            self.begin_turn('old', 'r0', 0, 'original')
        def recover_pending(self):
            self.recoveries += 1
            return super().recover_pending()
        def close(self):
            self.closes += 1
            super().close()
    clients = {'analysis': Role('analysis'), 'dialogue': Role('dialogue')}
    monkeypatch.setattr(runtime, 'make_role_clients', lambda settings: clients)
    monkeypatch.setattr(session_api, 'SessionStore', TrackingStore)
    app = create_app(settings=load_settings({}))
    async with app.router.lifespan_context(app):
        storage = app.state.session_api.store
        assert storage.recoveries == 1
        assert storage.get_turn('old', 'r0')['status'] == 'interrupted'
        storage.begin_turn('old', 'r1', 2, 'later')
        assert storage.get_turn('old', 'r1')['status'] == 'pending'
    assert storage.closes == 1
    assert all(client.closed == 1 for client in clients.values())


@pytest.mark.parametrize('streaming', [False, True])
async def test_app_shutdown_also_cancels_compatibility_chat_model_work(streaming):
    first = Role('analysis', gate=asyncio.Event())
    sending = None
    try:
        async with fixture(first=first) as (client, app, store, first, second):
            sending = asyncio.create_task(client.post('/api/chat', json={
                'messages': [{'role': 'user', 'content': 'hello'}], 'stream': streaming}))
            await asyncio.wait_for(first.started.wait(), 2)
        assert first.cancelled.is_set()
    finally:
        if sending:
            sending.cancel()
            await asyncio.gather(sending, return_exceptions=True)


async def test_startup_recovery_failure_still_closes_owned_resources(monkeypatch):
    import backend.agent.runtime as runtime
    import backend.session_api as session_api
    from fastapi import HTTPException
    stores = []
    class BrokenStartup(SessionStore):
        def __init__(self, path):
            super().__init__(path)
            self.closed = False
            stores.append(self)
        def recover_pending(self):
            raise RuntimeError('private SQL failure')
        def close(self):
            self.closed = True
            super().close()
    clients = {'analysis': Role('analysis'), 'dialogue': Role('dialogue')}
    monkeypatch.setattr(runtime, 'make_role_clients', lambda settings: clients)
    monkeypatch.setattr(session_api, 'SessionStore', BrokenStartup)
    app = create_app(settings=load_settings({}))
    with pytest.raises(HTTPException):
        async with app.router.lifespan_context(app):
            pytest.fail('Recovery should fail safely')
    assert stores[0].closed
    assert all(client.closed == 1 for client in clients.values())


async def test_owned_file_has_one_lifetime_owner_and_releases_after_close(tmp_path, monkeypatch):
    import backend.session_api as session_api
    from fastapi import HTTPException
    created = []
    class TrackedStore(SessionStore):
        def __init__(self, path):
            created.append(path)
            super().__init__(path)
    monkeypatch.setattr(session_api, 'SessionStore', TrackedStore)
    path = tmp_path / 'sessions.sqlite3'
    settings = replace(load_settings({}), session_db_path=path)
    roles = lambda: {'analysis': Role('analysis'), 'dialogue': Role('dialogue')}
    first = create_app(settings=settings, role_clients=roles())
    second = create_app(settings=settings, role_clients=roles())
    async with first.router.lifespan_context(first):
        storage = first.state.session_api.store
        storage.create({'id': 'active'})
        storage.begin_turn('active', 'r1', 0, 'private original text')
        with pytest.raises(HTTPException) as failure:
            async with second.router.lifespan_context(second):
                pytest.fail('A second owner must never start recovery')
        assert failure.value.status_code == 503
        assert len(created) == 1, 'The second owner must fail before opening SQLite'
        assert storage.get_turn('active', 'r1')['status'] == 'pending'
    third = create_app(settings=settings, role_clients=roles())
    async with third.router.lifespan_context(third):
        storage = third.state.session_api.store
        assert storage.get_turn('active', 'r1')['status'] == 'interrupted'
        assert storage.get('active')['messages'][0]['content'] == 'private original text'
    assert len(created) == 2
    assert (tmp_path / 'sessions.sqlite3.lock').read_bytes() == b'\x00'


async def test_owned_file_lock_released_even_when_startup_recovery_fails(tmp_path, monkeypatch):
    import backend.session_api as session_api
    from fastapi import HTTPException
    class BrokenStartup(SessionStore):
        def recover_pending(self):
            raise RuntimeError('private SQL failure')
    settings = replace(load_settings({}), session_db_path=tmp_path / 'sessions.sqlite3')
    roles = lambda: {'analysis': Role('analysis'), 'dialogue': Role('dialogue')}
    monkeypatch.setattr(session_api, 'SessionStore', BrokenStartup)
    broken = create_app(settings=settings, role_clients=roles())
    with pytest.raises(HTTPException):
        async with broken.router.lifespan_context(broken):
            pytest.fail('Recovery should fail')
    monkeypatch.setattr(session_api, 'SessionStore', SessionStore)
    healthy = create_app(settings=settings, role_clients=roles())
    async with healthy.router.lifespan_context(healthy):
        assert healthy.state.session_api.store.list() == []
