"""只验证本地 SDK/MCP 初始化与工具发现；不调用回答模型或 embeddings。"""
import asyncio
from dataclasses import replace
from pathlib import Path
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pydantic import BaseModel, ConfigDict
from openai_codex import AsyncCodex, ApprovalMode, Sandbox
from backend.codex_client import sdk_config
from backend.config import load_settings


class Response(BaseModel):
    model_config = ConfigDict(extra='allow')


async def main():
    settings = replace(load_settings(), embedding_key='offline-discovery-only')
    with tempfile.TemporaryDirectory(prefix='rag-discovery-') as directory:
        async with AsyncCodex(sdk_config(settings, directory)) as codex:
            account = (await codex.account()).model_dump(mode='json', by_alias=True)
            print('account_type:', (account.get('account') or {}).get('type'))
            await codex.thread_start(ephemeral=True, cwd=directory, sandbox=Sandbox.read_only,
                                     approval_mode=ApprovalMode.deny_all, base_instructions='Do not run any task.')
            result = await asyncio.to_thread(codex._client._sync.request, 'mcpServerStatus/list', {}, response_model=Response)
            data = result.model_dump()
            rows = data.get('data', [])
            summary = [{'name': row.get('name'), 'tools': list(row.get('tools', {}))} for row in rows]
            print('mcp_tools:', summary)
            enabled = [row for row in rows if row.get('tools')]
            assert len(enabled) == 1 and enabled[0]['name'] == 'personality_rag', 'Unexpected MCP tools'
            assert 'search_personality_knowledge' in enabled[0]['tools']
            print('PASS: no model turn, no embeddings request')


if __name__ == '__main__':
    asyncio.run(asyncio.wait_for(main(), 45))
