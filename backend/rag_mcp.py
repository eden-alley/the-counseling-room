"""单工具、进程级两次额度的 MCP stdio 服务。stdout 仅写协议，不写日志。"""
import asyncio
import json
import os
from pathlib import Path
import sys


class RagToolServer:
    def __init__(self, retriever):
        self.retriever = retriever
        self.calls = 0

    async def handle(self, message):
        if 'id' not in message:  # initialized/cancelled 等通知无需响应。
            return None
        method = message.get('method')
        result = {}
        if method == 'initialize':
            result = {'protocolVersion': '2024-11-05', 'capabilities': {'tools': {}},
                      'serverInfo': {'name': 'personality-draft-rag', 'version': '1.0'}}
        elif method == 'tools/list':
            result = {'tools': [{
                'name': 'search_personality_knowledge',
                'description': '检索待审人格知识草稿。用于核对理论解释，不是个人事实或诊断依据。每轮最多两次。结果含来源及限制。',
                'inputSchema': {'type': 'object', 'properties': {
                    'query': {'type': 'string', 'minLength': 1, 'maxLength': 1000},
                    'top_k': {'type': 'integer', 'minimum': 1, 'maximum': 5, 'default': 4}},
                    'required': ['query'], 'additionalProperties': False},
            }]}
        elif method == 'tools/call':
            try:
                params = message.get('params') or {}
                if params.get('name') != 'search_personality_knowledge':
                    raise ValueError('未知工具')
                args = params.get('arguments') or {}
                query, top_k = args.get('query'), args.get('top_k', 4)
                if (not isinstance(query, str) or not 1 <= len(query.strip()) <= 1000
                        or type(top_k) is not int or not 1 <= top_k <= 5
                        or set(args) - {'query', 'top_k'}):
                    raise ValueError('检索参数无效')
                if self.calls >= 2:
                    raise ValueError('本轮检索次数已用完')
                self.calls += 1  # 失败也计次，不让模型无限重试。
                data = await self.retriever.search(query, top_k=top_k)
                result = {'content': [{'type': 'text', 'text': json.dumps(data, ensure_ascii=False)}]}
            except Exception:
                result = {'isError': True, 'content': [{'type': 'text', 'text': '检索未完成（参数、额度或服务异常）。不得编造出处；请说明资料暂不可用。'}]}
        elif method != 'ping':
            return {'jsonrpc': '2.0', 'id': message['id'], 'error': {'code': -32601, 'message': 'Method not found'}}
        return {'jsonrpc': '2.0', 'id': message['id'], 'result': result}


async def main():
    from backend.retrieval import DraftRetriever
    retriever = DraftRetriever(Path(os.environ['RAG_INDEX_DIR']), Path(os.environ['RAG_CHUNKS_PATH']),
                               api_key=os.environ.get('DASHSCOPE_API_KEY', ''))
    server = RagToolServer(retriever)
    try:
        while line := await asyncio.to_thread(sys.stdin.buffer.readline):
            try:
                response = await server.handle(json.loads(line))
                if response is not None:
                    sys.stdout.buffer.write((json.dumps(response, ensure_ascii=False) + '\n').encode('utf-8'))
                    sys.stdout.buffer.flush()
            except (ValueError, TypeError, KeyError):
                continue
    finally:
        await retriever.aclose()


if __name__ == '__main__':
    asyncio.run(main())
