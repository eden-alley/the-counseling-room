"""启动：.venv/Scripts/python -m backend --static。按Ctrl+C退出。"""
import argparse
from dataclasses import replace
from getpass import getpass
from pathlib import Path
import os
import uvicorn

from .api import create_app
from .config import ROOT, load_settings, role_settings


def main():
    parser = argparse.ArgumentParser(description="咨询室Python后端，默认本地假模型")
    parser.add_argument('--static', action='store_true', help='同时提供dist/web里的已构建前端')
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=int(os.environ.get('PORT', '9000')))
    providers = parser.add_mutually_exclusive_group()
    providers.add_argument('--codex', action='store_true', help='使用已登录的Codex订阅与待审RAG；不会启用MiMo')
    providers.add_argument('--deepseek', action='store_true', help='使用DeepSeek API与现有百炼RAG')
    providers.add_argument('--qwen', action='store_true', help='使用千问API与现有百炼RAG')
    parser.add_argument('--deepseek-key-prompt', action='store_true', help='隐藏输入DeepSeek Key，仅保存在本进程')
    parser.add_argument('--embedding-key-prompt', action='store_true', help='启动时隐藏输入百炼Key，仅保存在本进程')
    args = parser.parse_args()
    if args.host not in {'127.0.0.1', 'localhost', '::1'}:
        parser.error('本机会话后端仅允许回环地址')
    env = dict(os.environ)
    if args.deepseek:
        env['MODEL_MODE'] = 'deepseek'
    if args.qwen:
        env['MODEL_MODE'] = 'qwen'
    if args.codex:
        env['MODEL_MODE'] = 'codex'
    settings = load_settings(env)
    if settings.mode in {'codex', 'deepseek', 'qwen'}:
        # 当前知识库 Worktree 布局可定位现有快照；其他安装位置需显式环境路径。
        corpus = ROOT.parents[3] / 'AI Personality Explorer' / '知识库' / 'chunks' / 'v0.1'
        settings = replace(settings,
            rag_index_dir=settings.rag_index_dir or corpus / 'rag-experiment-2026-10-22',
            rag_chunks_path=settings.rag_chunks_path or corpus / 'chunks.jsonl')
    if args.deepseek_key_prompt:
        if settings.mode != 'deepseek':
            parser.error('--deepseek-key-prompt 只用于 deepseek 模式')
        settings = replace(settings, api_key=getpass('DeepSeek Key（隐藏输入，不保存）: '))
    if args.embedding_key_prompt:
        if settings.mode not in {'codex', 'deepseek', 'qwen'}:
            parser.error('--embedding-key-prompt 只用于 codex/deepseek/qwen 模式')
        settings = replace(settings, embedding_key=getpass('百炼 Key（隐藏输入，不保存）: '))
        if settings.mode == 'qwen':
            settings = replace(settings, api_key=settings.embedding_key)
    if settings.mode in {'codex', 'deepseek', 'qwen'}:
        if settings.mode == 'deepseek' and not settings.api_key.strip():
            parser.error('请设置 DEEPSEEK_API_KEY 或使用 --deepseek-key-prompt')
        if settings.mode == 'qwen' and not settings.api_key.strip():
            parser.error('请设置 DASHSCOPE_API_KEY 或使用 --embedding-key-prompt')
        if settings.mode == 'codex' and (not settings.embedding_key.strip() or not settings.rag_index_dir or not settings.rag_chunks_path):
            parser.error('RAG配置不完整，请设置 DASHSCOPE_API_KEY 或使用 --embedding-key-prompt，并确认资料路径')
        if settings.embedding_key.strip() and settings.rag_index_dir and settings.rag_chunks_path:
            from .retrieval import DraftRetriever, RetrievalError
            try:
                # 只验证本地快照，不发 embeddings 请求。
                DraftRetriever(settings.rag_index_dir, settings.rag_chunks_path, api_key=settings.embedding_key)
            except RetrievalError:
                if settings.mode == 'codex':
                    parser.error('Codex 检索快照不可用，请检查配置')
                print('检索快照不可用；普通对话仍可使用，检索将返回 unavailable。', flush=True)
    data_root = Path(env.get('LOCALAPPDATA', str(Path.home() / 'AppData' / 'Local')))
    session_path = settings.session_db_path or data_root / 'AI-Personality-Explorer' / 'consultations.sqlite3'
    session_path = session_path.expanduser().resolve()
    session_path.parent.mkdir(parents=True, exist_ok=True)
    settings = replace(settings, session_db_path=session_path)
    if settings.mode in {'mock', 'deepseek', 'qwen'}:
        roles = {role: role_settings(settings, role) for role in ('analysis', 'dialogue')}
        selected = '; '.join(f'{role}={config.mode}/{config.model if config.mode != "mock" else "offline"}' for role, config in roles.items())
        print(selected + ('（模拟响应，无模型请求）' if all(config.mode == 'mock' for config in roles.values()) else '（真实模型模式）'), flush=True)
    else:
        print(f'MODEL_MODE={settings.mode}; MODEL={settings.model}', flush=True)
    app = create_app(settings=settings, static_root=ROOT / 'dist' / 'web' if args.static else None)
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == '__main__':
    main()
