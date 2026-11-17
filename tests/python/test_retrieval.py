import hashlib
import json

import httpx
import pytest

from backend.retrieval import DraftRetriever, RetrievalError


def _write_index(tmp_path, *, rows=None, chunks=None, manifest=None):
    text = "候选知识正文。"
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    if chunks is None:
        chunks = [
            {
                "chunk_id": "chunk-1",
                "text": text,
                "embedding_text_sha256": digest,
                "parent_path": "topics/example.md",
                "heading_path": ["主题", "小节"],
                "source_refs": [{"source_id": "SRC-1"}],
                "parent_review_status": "pending_source_and_domain_review",
                "rights_status": "product_reuse_unconfirmed",
                "original_locator_status": "parent_scope_only",
                "retrieval_eligible": False,
                "runtime_enabled": False,
            }
        ]
    if rows is None:
        vector = [0.0] * 1024
        vector[0] = 1.0
        rows = [{"chunk_id": "chunk-1", "text": text, "embedding_text_sha256": digest, "embedding": vector}]
    if manifest is None:
        manifest = {"model": "qwen3.7-text-embedding", "dimensions": 1024}

    index_dir = tmp_path / "index"
    index_dir.mkdir()
    (index_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    (index_dir / "vectors.jsonl").write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in rows), encoding="utf-8")
    chunks_path = tmp_path / "chunks.jsonl"
    chunks_path.write_text("\n".join(json.dumps(chunk, ensure_ascii=False) for chunk in chunks), encoding="utf-8")
    return index_dir, chunks_path


def _embedding_response(vector=None):
    vector = vector or [0.0] * 1024
    if not any(vector):
        vector[0] = 1.0
    return {"data": [{"index": 0, "embedding": vector}], "model": "qwen3.7-text-embedding", "usage": {"total_tokens": 3}}


@pytest.mark.asyncio
async def test_search_sends_one_compatible_embedding_request_and_returns_attributed_draft(tmp_path):
    index_dir, chunks_path = _write_index(tmp_path)
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(200, json=_embedding_response())

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    retriever = DraftRetriever(index_dir, chunks_path, api_key="test-secret", http_client=client)
    result = await retriever.search("测试检索")
    await retriever.aclose()

    assert len(requests) == 1
    assert str(requests[0].url) == "https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings"
    assert requests[0].headers["authorization"] == "Bearer test-secret"
    assert json.loads(requests[0].content) == {"model": "qwen3.7-text-embedding", "input": "测试检索", "dimensions": 1024}
    assert requests[0].extensions["timeout"]["read"] == 20.0
    assert result["status"] == "draft_only"
    assert result["query"] == "测试检索"
    assert result["results"][0]["chunk_id"] == "chunk-1"
    assert result["results"][0]["text"] == "候选知识正文。"
    assert result["results"][0]["score"] == pytest.approx(1.0)
    assert result["results"][0]["parent_review_status"] == "pending_source_and_domain_review"
    assert result["results"][0]["rights_status"] == "product_reuse_unconfirmed"
    assert result["results"][0]["original_locator_status"] == "parent_scope_only"
    assert result["results"][0]["parent_path"] == "topics/example.md"
    assert result["results"][0]["heading_path"] == ["主题", "小节"]
    assert result["results"][0]["source_refs"] == [{"source_id": "SRC-1"}]
    assert result["limitations"]


def test_constructor_rejects_manifest_for_a_different_embedding_model(tmp_path):
    index_dir, chunks_path = _write_index(tmp_path, manifest={"model": "other-model", "dimensions": 1024})
    with pytest.raises(RetrievalError):
        DraftRetriever(index_dir, chunks_path, api_key="test-secret")


def test_constructor_rejects_vector_that_does_not_match_complete_chunk_text(tmp_path):
    index_dir, chunks_path = _write_index(tmp_path, rows=[{
        "chunk_id": "chunk-1", "text": "被篡改的正文", "embedding_text_sha256": "0" * 64,
        "embedding": [1.0] + [0.0] * 1023,
    }])
    with pytest.raises(RetrievalError):
        DraftRetriever(index_dir, chunks_path, api_key="test-secret")


@pytest.mark.parametrize("bad_vector", [[0.0] * 1024, [float("nan")] + [0.0] * 1023])
def test_constructor_rejects_zero_or_non_finite_index_vectors(tmp_path, bad_vector):
    index_dir, chunks_path = _write_index(tmp_path, rows=[{
        "chunk_id": "chunk-1", "text": "候选知识正文。",
        "embedding_text_sha256": hashlib.sha256("候选知识正文。".encode()).hexdigest(),
        "embedding": bad_vector,
    }])
    with pytest.raises(RetrievalError):
        DraftRetriever(index_dir, chunks_path, api_key="test-secret")


@pytest.mark.asyncio
async def test_search_rejects_query_over_1000_characters_without_request(tmp_path):
    index_dir, chunks_path = _write_index(tmp_path)
    calls = []
    client = httpx.AsyncClient(transport=httpx.MockTransport(lambda request: calls.append(request)))
    retriever = DraftRetriever(index_dir, chunks_path, api_key="test-secret", http_client=client)
    with pytest.raises(RetrievalError):
        await retriever.search("q" * 1001)
    assert not calls
    await retriever.aclose()


@pytest.mark.asyncio
async def test_search_anonymizes_rate_limit_response_and_does_not_retry(tmp_path):
    index_dir, chunks_path = _write_index(tmp_path)
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(429, text="secret-token private provider detail")

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    retriever = DraftRetriever(index_dir, chunks_path, api_key="test-secret", http_client=client)
    with pytest.raises(RetrievalError) as caught:
        await retriever.search("测试")
    assert "secret-token" not in str(caught.value)
    assert "private provider detail" not in str(caught.value)
    assert len(calls) == 1
    await retriever.aclose()


@pytest.mark.asyncio
async def test_search_rejects_malformed_embedding_response_without_exposing_body(tmp_path):
    index_dir, chunks_path = _write_index(tmp_path)
    client = httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, text="api-key leaked body")))
    retriever = DraftRetriever(index_dir, chunks_path, api_key="test-secret", http_client=client)
    with pytest.raises(RetrievalError) as caught:
        await retriever.search("测试")
    assert "api-key" not in str(caught.value)
    assert "leaked body" not in str(caught.value)
    await retriever.aclose()


@pytest.mark.asyncio
async def test_search_clamps_top_k_and_returns_cosine_ranked_results(tmp_path):
    index_dir, chunks_path = _write_index(tmp_path)
    text = "第二条。"
    digest = hashlib.sha256(text.encode()).hexdigest()
    rows = [
        {"chunk_id": "chunk-1", "text": "候选知识正文。", "embedding_text_sha256": hashlib.sha256("候选知识正文。".encode()).hexdigest(), "embedding": [1.0] + [0.0] * 1023},
        {"chunk_id": "chunk-2", "text": text, "embedding_text_sha256": digest, "embedding": [0.0, 1.0] + [0.0] * 1022},
    ]
    base_chunks = json.loads(chunks_path.read_text(encoding="utf-8").splitlines()[0])
    chunks_path.write_text("\n".join(json.dumps(c, ensure_ascii=False) for c in [base_chunks, {**base_chunks, "chunk_id": "chunk-2", "text": text, "embedding_text_sha256": digest}]), encoding="utf-8")
    (index_dir / "vectors.jsonl").write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in rows), encoding="utf-8")
    query = [0.8, 0.6] + [0.0] * 1022
    client = httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, json=_embedding_response(query))))
    retriever = DraftRetriever(index_dir, chunks_path, api_key="test-secret", http_client=client)
    result = await retriever.search("测试", top_k=9)
    await retriever.aclose()
    assert [item["chunk_id"] for item in result["results"]] == ["chunk-1", "chunk-2"]
    assert [item["score"] for item in result["results"]] == pytest.approx([0.8, 0.6])


async def test_unconfigured_dialogue_scope_does_not_request_embeddings(tmp_path):
    index_dir, chunks_path = _write_index(tmp_path)
    requests = []
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: requests.append(request))) as http:
        retriever = DraftRetriever(index_dir, chunks_path, api_key='fixture', http_client=http)
        result = await retriever.search('如何承接表达', scope='dialogue')
    assert result['status'] == 'unavailable' and result['results'] == []
    assert not requests


async def test_scope_filters_before_top_k(tmp_path):
    texts = ['相似度很高的理论。', '相似度较低的沟通过程。']
    chunks = [{'chunk_id': f'c{i}', 'text': text, 'embedding_text_sha256': hashlib.sha256(text.encode()).hexdigest(),
               'scope': 'analysis' if i == 0 else 'dialogue'} for i, text in enumerate(texts)]
    rows = [{**chunk, 'embedding': ([1.0, 0.0] if i == 0 else [0.5, 0.5]) + [0.0] * 1022}
            for i, chunk in enumerate(chunks)]
    index_dir, chunks_path = _write_index(tmp_path, rows=rows, chunks=chunks)
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, json=_embedding_response()))) as http:
        retriever = DraftRetriever(index_dir, chunks_path, api_key='fixture', http_client=http)
        result = await retriever.search('沟通过程', top_k=1, scope='dialogue')
    assert [row['chunk_id'] for row in result['results']] == ['c1']
    assert result['scope'] == 'dialogue'
