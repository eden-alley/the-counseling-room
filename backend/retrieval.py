"""基于待审知识向量的显式内部试用检索器。"""

from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
from typing import Any

import httpx


_MODEL = "qwen3.7-text-embedding"
_DIMENSIONS = 1024
_EMBEDDINGS_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings"
_TIMEOUT_SECONDS = 20.0
_LIMITATIONS = (
    "仅供待审资料的显式内部试用，不构成专业复核、产品复用许可或对检索内容的背书；"
    "结果不得作为诊断、用户画像或咨询结论。"
)


class RetrievalError(Exception):
    """只包含静态安全消息的本地校验或检索错误。"""


def _load_json(path: Path, message: str) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise RetrievalError(message) from None


def _load_jsonl(path: Path, message: str) -> list[dict[str, Any]]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
        rows = [json.loads(line) for line in lines if line.strip()]
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise RetrievalError(message) from None
    if not all(isinstance(row, dict) for row in rows):
        raise RetrievalError(message)
    return rows


def _vector(value: Any, *, message: str) -> list[float]:
    if not isinstance(value, list) or len(value) != _DIMENSIONS:
        raise RetrievalError(message)
    if any(isinstance(item, bool) or not isinstance(item, (int, float)) for item in value):
        raise RetrievalError(message)
    result = [float(item) for item in value]
    if not all(math.isfinite(item) for item in result) or not any(item != 0.0 for item in result):
        raise RetrievalError(message)
    return result


def _normalized(vector: list[float]) -> list[float]:
    norm = math.sqrt(sum(value * value for value in vector))
    if not math.isfinite(norm) or norm == 0.0:
        raise RetrievalError("检索向量无效。")
    return [value / norm for value in vector]


def _sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


class DraftRetriever:
    """本地验证固定向量快照，仅在 search 时请求一次云端查询向量。"""

    def __init__(
        self,
        index_dir: Path,
        chunks_path: Path,
        *,
        api_key: str,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self.configured = isinstance(api_key, str) and bool(api_key.strip())
        self._api_key = api_key.strip() if isinstance(api_key, str) else ""
        self._http_client = http_client
        self._owns_http_client = False
        self._vectors: dict[str, list[float]] = {}
        self._chunks: dict[str, dict[str, Any]] = {}
        self._load_snapshot(Path(index_dir), Path(chunks_path))

    def _load_snapshot(self, index_dir: Path, chunks_path: Path) -> None:
        manifest = _load_json(index_dir / "manifest.json", "检索索引清单无法读取。")
        if not isinstance(manifest, dict) or manifest.get("model") != _MODEL or manifest.get("dimensions") != _DIMENSIONS:
            raise RetrievalError("检索索引模型或向量维度不匹配。")

        vector_rows = _load_jsonl(index_dir / "vectors.jsonl", "检索向量文件无法读取。")
        chunk_rows = _load_jsonl(chunks_path, "知识切片文件无法读取。")
        if not vector_rows or not chunk_rows:
            raise RetrievalError("检索索引或知识切片为空。")

        vectors_by_id: dict[str, dict[str, Any]] = {}
        chunks_by_id: dict[str, dict[str, Any]] = {}
        for row in vector_rows:
            chunk_id = row.get("chunk_id")
            if not isinstance(chunk_id, str) or not chunk_id or chunk_id in vectors_by_id:
                raise RetrievalError("检索向量包含无效或重复切片编号。")
            vectors_by_id[chunk_id] = row
        for row in chunk_rows:
            chunk_id = row.get("chunk_id")
            if not isinstance(chunk_id, str) or not chunk_id or chunk_id in chunks_by_id:
                raise RetrievalError("知识切片包含无效或重复切片编号。")
            chunks_by_id[chunk_id] = row
        # The complete corpus also contains non-embedding-eligible rows; the
        # fixed experimental index is a verified subset of that corpus.
        if not vectors_by_id.keys() <= chunks_by_id.keys():
            raise RetrievalError("检索向量与完整知识切片不一致。")

        for chunk_id, vector_row in vectors_by_id.items():
            chunk = chunks_by_id[chunk_id]
            text = vector_row.get("text")
            vector_hash = vector_row.get("embedding_text_sha256")
            if (
                not isinstance(text, str)
                or not isinstance(chunk.get("text"), str)
                or text != chunk["text"]
                or not isinstance(vector_hash, str)
                or vector_hash != chunk.get("embedding_text_sha256")
                or _sha256_text(text) != vector_hash
            ):
                raise RetrievalError("检索向量与完整知识切片正文或哈希不一致。")
            self._vectors[chunk_id] = _normalized(_vector(vector_row.get("embedding"), message="检索索引含无效向量。"))
            self._chunks[chunk_id] = chunk

    async def search(self, query: str, top_k: int = 4, *, scope: str = 'analysis') -> dict[str, Any]:
        if not isinstance(query, str) or not query.strip() or len(query) > 1000:
            raise RetrievalError("检索问题必须为1至1000个字符。")
        if not isinstance(top_k, int) or isinstance(top_k, bool):
            raise RetrievalError("检索数量必须是1至5之间的整数。")
        top_k = min(5, max(1, top_k))
        if scope not in {'analysis', 'dialogue'}:
            raise RetrievalError('检索资料范围无效。')
        # 现有无 scope 的理论快照属于 analysis；没有沟通材料就不发查询向量请求。
        eligible = {chunk_id: vector for chunk_id, vector in self._vectors.items()
                    if self._chunks[chunk_id].get('scope', 'analysis') == scope}
        if not eligible:
            return {'status': 'unavailable', 'scope': scope, 'query': query, 'results': [],
                    'limitations': _LIMITATIONS, 'reason': '该角色资料尚未配置。'}
        if not self.configured:
            raise RetrievalError("检索服务尚未配置。")

        client = self._http_client
        if client is None:
            client = httpx.AsyncClient(timeout=httpx.Timeout(_TIMEOUT_SECONDS))
            self._http_client = client
            self._owns_http_client = True
        try:
            response = await client.post(
                _EMBEDDINGS_URL,
                headers={"Authorization": f"Bearer {self._api_key}"},
                json={"model": _MODEL, "input": query, "dimensions": _DIMENSIONS},
                timeout=_TIMEOUT_SECONDS,
            )
        except httpx.TimeoutException:
            raise RetrievalError("查询向量请求超时。") from None
        except httpx.RequestError:
            raise RetrievalError("暂时无法连接查询向量服务。") from None
        except Exception:
            raise RetrievalError("查询向量请求失败。") from None

        if response.status_code == 429:
            raise RetrievalError("查询向量服务暂时限流，请稍后再试。")
        if response.status_code < 200 or response.status_code >= 300:
            raise RetrievalError("查询向量服务暂时不可用。")
        try:
            payload = response.json()
            data = payload.get("data") if isinstance(payload, dict) else None
            if not isinstance(data, list) or len(data) != 1 or data[0].get("index") != 0:
                raise ValueError
            query_vector = _normalized(_vector(data[0].get("embedding"), message="查询向量响应无效。"))
        except (ValueError, TypeError, AttributeError, RetrievalError):
            raise RetrievalError("查询向量响应无效。") from None

        ranked = sorted(
            ((sum(left * right for left, right in zip(query_vector, vector)), chunk_id) for chunk_id, vector in eligible.items()),
            key=lambda item: (-item[0], item[1]),
        )[:top_k]
        results = []
        for score, chunk_id in ranked:
            chunk = self._chunks[chunk_id]
            results.append({
                "chunk_id": chunk_id,
                "score": score,
                "text": chunk["text"],
                "source_refs": chunk.get("source_refs", []),
                "parent_path": chunk.get("parent_path"),
                "heading_path": chunk.get("heading_path", []),
                "parent_review_status": chunk.get("parent_review_status"),
                "rights_status": chunk.get("rights_status"),
                "original_locator_status": chunk.get("original_locator_status"),
                "embedding_text_sha256": chunk.get("embedding_text_sha256"),
            })
        return {"status": "draft_only", "scope": scope, "query": query, "results": results, "limitations": _LIMITATIONS}

    async def aclose(self) -> None:
        if self._owns_http_client and self._http_client is not None:
            await self._http_client.aclose()
            self._http_client = None
            self._owns_http_client = False
