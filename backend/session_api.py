"""Local session transport. Only committed public projections cross this boundary."""
import asyncio
import ipaddress
import json
import os
from pathlib import Path
from urllib.parse import urlsplit

import anyio
from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .model_client import ModelError
from .session_store import SessionError, SessionStore


class StrictBody(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)


class SessionBody(StrictBody):
    session: dict


class TurnBody(StrictBody):
    request_id: str = Field(min_length=1, max_length=200)
    expected_revision: int = Field(ge=0)
    message: str = Field(min_length=1, max_length=8000)
    retry_of: str | None = Field(default=None, min_length=1, max_length=200)
    stream: bool = False


class RevisionBody(StrictBody):
    expected_revision: int = Field(ge=0)


class MetadataBody(RevisionBody):
    metadata: dict = Field(default_factory=dict)


def _loopback(value, *, origin=False):
    """Parse syntactically; never resolve attacker-controlled DNS names."""
    if not value or any(character.isspace() for character in value):
        return False
    try:
        parsed = urlsplit(value if origin else '//' + value)
        if origin and parsed.scheme not in ('http', 'https'):
            return False
        if parsed.username is not None or parsed.password is not None or parsed.path or parsed.query or parsed.fragment:
            return False
        if not parsed.netloc or parsed.port is not None and not 0 < parsed.port <= 65535:
            return False
        hostname = parsed.hostname
        if hostname == 'localhost':
            return True
        return ipaddress.ip_address(hostname).is_loopback
    except (ValueError, TypeError):
        return False


class SessionBoundaryMiddleware:
    """Guard reads too, and replace legacy wildcard CORS only for session paths."""
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        path = scope.get('path', '')
        if scope['type'] != 'http' or not (path == '/api/sessions' or path.startswith('/api/sessions/')):
            return await self.app(scope, receive, send)
        headers = scope.get('headers', [])
        hosts = [value.decode('latin-1') for key, value in headers if key.lower() == b'host']
        origins = [value.decode('latin-1') for key, value in headers if key.lower() == b'origin']
        if len(hosts) != 1 or not _loopback(hosts[0]) or len(origins) > 1 or origins and not _loopback(origins[0], origin=True):
            return await JSONResponse({'error': '会话接口只允许本机访问。'}, status_code=403)(scope, receive, send)

        async def safe_send(message):
            if message['type'] == 'http.response.start':
                response_headers = [(key, value) for key, value in message.get('headers', [])
                                    if key.lower() not in (b'access-control-allow-origin', b'access-control-allow-credentials')]
                if origins:
                    response_headers.extend([(b'access-control-allow-origin', origins[0].encode('latin-1')),
                                             (b'vary', b'Origin')])
                message = {**message, 'headers': response_headers}
            await send(message)

        await self.app(scope, receive, safe_send)


def _event(value):
    return f"event: {value['type']}\ndata: {json.dumps(value, ensure_ascii=False)}\n\n"


class _StoreOwner:
    """OS-held lifetime lock; the sidecar contains one zero byte, never data.

    Keep the sidecar after release: unlinking a lock file can split owners
    across two different inodes while another process still holds it open.
    """
    def __init__(self, database_path):
        self.path = Path(str(database_path) + '.lock')
        self.handle = None

    def acquire(self):
        handle = None
        try:
            handle = self.path.open('a+b')
            if os.name == 'nt':
                import msvcrt
                handle.seek(0, os.SEEK_END)
                if handle.tell() == 0:
                    handle.write(b'\x00')
                    handle.flush()
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                if self.path.stat().st_size == 0:
                    handle.write(b'\x00')
                    handle.flush()
            self.handle = handle
        except OSError:
            if handle is not None:
                handle.close()
            raise HTTPException(503, '会话存储已被其他本机服务占用，或暂时无法取得独占访问。') from None

    def release(self):
        if self.handle is not None:
            # Closing the OS handle also releases the lock after a crash or
            # exceptional shutdown; no persisted ownership flag can go stale.
            self.handle.close()
            self.handle = None


class SessionAPI:
    def __init__(self, settings, counselor, *, store=None, ready=None):
        self.settings, self.counselor = settings, counselor
        self.owns_store = store is None
        self.path = getattr(settings, 'session_db_path', None) or ':memory:'
        self.owner = None
        if self.owns_store and str(self.path) != ':memory:':
            self.path = Path(self.path).resolve()
            self.owner = _StoreOwner(self.path)
        # File-backed owned stores are opened only after taking the lifetime
        # lock at startup. Injected stores preserve their caller's lifecycle.
        self.store = SessionStore(':memory:') if self.owns_store and self.owner is None else store
        self.ready = ready or (lambda: counselor is not None)
        self.tasks = {}

    def call(self, method, *args, **kwargs):
        try:
            return getattr(self.store, method)(*args, **kwargs)
        except SessionError as error:
            raise HTTPException(error.status, str(error)) from None
        except Exception:
            raise HTTPException(500, '本机会话存储暂时不可用。') from None

    def startup(self):
        if self.owns_store:
            if self.owner is not None:
                self.owner.acquire()
                try:
                    self.store = SessionStore(self.path)
                except Exception:
                    self.owner.release()
                    raise HTTPException(500, '本机会话存储暂时不可用。') from None
            self.call('recover_pending')

    async def shutdown(self):
        try:
            for key, task in list(self.tasks.items()):
                await self.cancel(key, task)
        finally:
            if self.owns_store:
                try:
                    if self.store is not None:
                        self.store.close()
                finally:
                    if self.owner is not None:
                        self.owner.release()

    async def body(self, request, schema, *, allow_empty=False):
        raw = bytearray()
        async for chunk in request.stream():
            if len(raw) + len(chunk) > self.settings.max_body_bytes:
                raise HTTPException(413, '对话内容过长，请导出后开始新对话。')
            raw.extend(chunk)
        try:
            return schema.model_validate({} if allow_empty and not raw else json.loads(raw))
        except (ValueError, TypeError, ValidationError, RecursionError):
            raise HTTPException(400, '请求内容或对话记录无效。') from None

    def outcome(self, sid, rid):
        turn = self.call('get_turn', sid, rid)
        session = self.call('get', sid)
        public = {'request_id': rid, 'revision': session['revision'], 'session': session}
        if turn['status'] == 'completed':
            return {'reply': turn['reply'], **public}
        return {'error': '本轮未完成，请查询状态后重试。', 'status': 409, **public}

    def safe_failure(self, sid, rid, status=502):
        value = {'error': '本次回复未完成，请稍后重试。', 'status': status, 'request_id': rid}
        try:
            session = self.call('get', sid)
            value.update(revision=session['revision'], session=session)
        except HTTPException:
            pass
        return value

    def fail(self, sid, rid, status):
        # Cancellation/delete may already have invalidated the request.
        try:
            return self.call('fail_turn', sid, rid, status)
        except HTTPException:
            return None

    async def generate(self, sid, rid, accepted):
        try:
            result = await self.counselor.run_turn(accepted['messages'], previous_state=accepted['internal_state'],
                                                 entry_context=accepted['session'].get('promptContext', ''))
            self.call('complete_turn', sid, rid, accepted['accepted_revision'], result)
            return self.outcome(sid, rid)
        except asyncio.CancelledError:
            self.fail(sid, rid, 'interrupted')
            raise
        except HTTPException as error:
            self.fail(sid, rid, 'failed')
            return self.safe_failure(sid, rid, error.status_code)
        except Exception as error:
            self.fail(sid, rid, 'failed')
            status = error.status if isinstance(error, ModelError) and error.status in (429, 502, 503, 504) else 502
            return self.safe_failure(sid, rid, status)

    async def cancel(self, key, task=None):
        sid, rid = key
        self.fail(sid, rid, 'interrupted')
        task = task or self.tasks.get(key)
        if task is not None and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def wait(self, request, task, key):
        async def disconnected():
            while True:
                if (await request.receive())['type'] == 'http.disconnect':
                    return
        watcher = asyncio.create_task(disconnected())
        try:
            completed, _ = await asyncio.wait([task, watcher], return_when=asyncio.FIRST_COMPLETED)
            if task in completed:
                try:
                    return await task
                except asyncio.CancelledError:
                    return self.safe_failure(*key, 409)
            raise asyncio.CancelledError()
        finally:
            watcher.cancel()
            # Starlette cancels stream generators inside an AnyIO cancel scope.
            with anyio.CancelScope(shield=True):
                await asyncio.gather(watcher, return_exceptions=True)
                if not task.done():
                    await self.cancel(key, task)

    def attach(self, app):
        app.state.session_api = self

        @app.post('/api/sessions')
        async def create(request: Request):
            body = await self.body(request, SessionBody)
            return {'session': self.call('create', body.session)}

        @app.post('/api/sessions/import')
        async def import_session(request: Request):
            body = await self.body(request, SessionBody)
            return {'session': self.call('create', body.session, imported=True)}

        @app.get('/api/sessions')
        async def list_sessions():
            return {'sessions': self.call('list')}

        @app.get('/api/sessions/{sid}')
        async def get_session(sid: str):
            return {'session': self.call('get', sid)}

        @app.post('/api/sessions/{sid}/turns')
        async def turn(sid: str, request: Request):
            body = await self.body(request, TurnBody)
            # 已存在请求先验证并回放；配置失效不能让已完成结果不可恢复。
            try:
                self.call('get_turn', sid, body.request_id)
            except HTTPException as error:
                if error.status_code != 404:
                    raise
                # No new user message is registered until a usable runtime is ready.
                if self.counselor is None or not self.ready():
                    raise HTTPException(503, '服务尚未完成配置。') from None
            accepted = self.call('begin_turn', sid, body.request_id, body.expected_revision, body.message, retry_of=body.retry_of)
            key = (sid, body.request_id)
            task = self.tasks.get(key)
            if accepted['created']:
                task = asyncio.create_task(self.generate(sid, body.request_id, accepted))
                self.tasks[key] = task
                def finished(done):
                    if self.tasks.get(key) is done:
                        self.tasks.pop(key, None)
                task.add_done_callback(finished)

            async def result():
                if task is None:
                    return self.outcome(*key)
                return await self.wait(request, task, key)

            if not body.stream:
                if task is None and accepted['turn']['status'] == 'pending':
                    return JSONResponse({'request_id': body.request_id, 'revision': accepted['session']['revision'],
                                         'session': accepted['session']}, status_code=202)
                value = await result()
                return JSONResponse(value, status_code=value.get('status', 200))

            async def events():
                try:
                    yield _event({'type': 'accepted', 'request_id': body.request_id,
                                  'revision': accepted['session']['revision'], 'session': accepted['session']})
                    value = await result()
                    if 'error' in value:
                        yield _event({'type': 'error', **value})
                    else:
                        yield _event({'type': 'delta', 'text': value['reply']})
                        yield _event({'type': 'done', **value})
                finally:
                    if task is not None and not task.done():
                        with anyio.CancelScope(shield=True):
                            await self.cancel(key, task)
            return StreamingResponse(events(), media_type='text/event-stream', headers={
                'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff'})

        @app.get('/api/sessions/{sid}/turns/{rid}')
        async def get_turn(sid: str, rid: str):
            return {'turn': self.call('get_turn', sid, rid), 'session': self.call('get', sid)}

        @app.post('/api/sessions/{sid}/turns/{rid}/cancel')
        async def cancel_turn(sid: str, rid: str, request: Request):
            await self.body(request, StrictBody, allow_empty=True)
            # Validate existence before interruption; completed requests are immutable.
            self.call('get_turn', sid, rid)
            await self.cancel((sid, rid))
            return {'turn': self.call('get_turn', sid, rid), 'session': self.call('get', sid)}

        @app.post('/api/sessions/{sid}/save')
        async def save(sid: str, request: Request):
            body = await self.body(request, MetadataBody)
            return {'session': self.call('save', sid, body.expected_revision, body.metadata)}

        @app.post('/api/sessions/{sid}/discard')
        async def discard(sid: str, request: Request):
            body = await self.body(request, RevisionBody)
            return {'session': self.call('discard', sid, body.expected_revision)}

        @app.post('/api/sessions/{sid}/metadata')
        async def metadata(sid: str, request: Request):
            body = await self.body(request, MetadataBody)
            return {'session': self.call('update_metadata', sid, body.expected_revision, body.metadata)}

        @app.delete('/api/sessions/{sid}')
        async def delete(sid: str, request: Request):
            body = await self.body(request, RevisionBody)
            return {'session': self.call('delete', sid, body.expected_revision)}
