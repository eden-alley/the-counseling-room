"""只访问127.0.0.1：验证真实HTTP断开能停止图中的上游生成。"""
import asyncio
import socket
import tempfile
from pathlib import Path
from contextlib import asynccontextmanager
from dataclasses import replace

import httpx
import pytest
import uvicorn

from backend.api import create_app
from backend.config import load_settings
from backend.model_client import MockModelClient


@asynccontextmanager
async def local_server(app):
    listener = socket.socket()
    listener.bind(('127.0.0.1', 0))
    address = f'http://127.0.0.1:{listener.getsockname()[1]}'
    server = uvicorn.Server(uvicorn.Config(app, log_level='critical', access_log=False))
    task = asyncio.create_task(server.serve(sockets=[listener]))
    try:
        async with asyncio.timeout(3):
            while not server.started:
                if task.done():
                    await task
                await asyncio.sleep(0.01)
        yield address
    finally:
        server.should_exit = True
        await asyncio.wait_for(task, 3)
        listener.close()


@pytest.mark.parametrize('streaming', [True, False])
async def test_disconnect_cancels_in_progress_model(streaming):
    started, cancelled = asyncio.Event(), asyncio.Event()

    class WaitingModel(MockModelClient):
        async def stream(self, messages, **options):
            try:
                started.set()
                yield 'x' * 100
                await asyncio.Event().wait()
            finally:
                cancelled.set()

    app = create_app(settings=replace(load_settings({}), mode='mimo'), model_client=WaitingModel())
    async with local_server(app) as base:
        async with httpx.AsyncClient(base_url=base, trust_env=False) as client:
            payload = {'messages': [{'role': 'user', 'content': 'test'}], 'stream': streaming}
            if streaming:
                async with client.stream('POST', '/api/chat', json=payload) as response:
                    async for text in response.aiter_text():
                        if 'event: delta' in text:
                            break
            else:
                sending = asyncio.create_task(client.post('/api/chat', json=payload))
                await asyncio.wait_for(started.wait(), 2)
                sending.cancel()
                await asyncio.gather(sending, return_exceptions=True)
            await asyncio.wait_for(cancelled.wait(), 2)


async def test_static_preview_and_default_mock():
    # 使用测试自己的目录，不依赖机器上其它账户创建的pytest临时目录。
    temporary_root = Path(__file__).resolve().parents[2] / 'test-results'
    temporary_root.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='counselor-', dir=temporary_root) as directory:
        await check_static_preview(Path(directory))


async def check_static_preview(tmp_path):
    (tmp_path / 'index.html').write_text('<h1>local preview</h1>', encoding='utf-8')
    app = create_app(settings=load_settings({}), static_root=tmp_path)
    async with local_server(app) as base:
        async with httpx.AsyncClient(base_url=base, trust_env=False) as client:
            assert (await client.get('/')).text == '<h1>local preview</h1>'
            assert (await client.get('/%2e%2e%2frequirements.txt')).status_code == 400
            body = {'messages': [{'role': 'user', 'content': 'test'}]}
            response = await client.post('/api/chat', json=body)
            assert '本地模拟' in response.json()['reply']
            assert (await client.post('/api/report/audit', json=body)).json() == {'questions': []}
