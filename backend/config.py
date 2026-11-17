"""读取配置与已有提示词；默认假模型，只有显式选择才启用真实模型。"""
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Mapping
import os

ROOT = Path(__file__).resolve().parent.parent


@dataclass(frozen=True)
class Settings:
    mode: str
    system_prompt: str
    consultant_corpus: str
    report_prompt: str
    model: str = "mimo-v2.5-pro"
    url: str = "https://api.xiaomimimo.com/v1/chat/completions"
    api_key: str = field(default="", repr=False)
    max_body_bytes: int = 160_000
    max_requests: int = 10
    window_seconds: float = 60.0
    codex_model: str = "gpt-6.1-sol"
    embedding_key: str = field(default="", repr=False)
    rag_index_dir: Path | None = None
    rag_chunks_path: Path | None = None
    session_db_path: Path | None = None
    role_overrides: dict = field(default_factory=dict, repr=False)


def role_settings(settings: Settings, role: str) -> Settings:
    override = settings.role_overrides.get(role, {})
    provider = override.get('mode', settings.mode)
    if provider not in {'mock', 'qwen', 'deepseek'}:
        raise ValueError('双角色仅支持 mock/qwen/deepseek')
    return replace(settings, **override, role_overrides={})


def load_settings(env: Mapping[str, str] | None = None) -> Settings:
    env = os.environ if env is None else env
    mode = env.get("MODEL_MODE", "mock")
    if mode not in {"mock", "mimo", "codex", "deepseek", "qwen"}:
        raise ValueError("MODEL_MODE must be mock, mimo, codex, deepseek or qwen")
    role_overrides = {}
    for role in ('analysis', 'dialogue'):
        prefix = role.upper()
        provider = env.get(f'{prefix}_PROVIDER', mode)
        if provider not in {'mock', 'qwen', 'deepseek'}:
            if f'{prefix}_PROVIDER' in env:
                raise ValueError(f'{prefix}_PROVIDER must be mock, qwen or deepseek')
            continue  # 旧模式不启用双角色。
        if not any(env.get(f'{prefix}_{key}') for key in ('PROVIDER', 'MODEL', 'API_URL')):
            continue
        provider_prefix = 'QWEN' if provider == 'qwen' else 'DEEPSEEK'
        role_overrides[role] = {
            'mode': provider,
            'model': env.get(f'{prefix}_MODEL', env.get(f'{provider_prefix}_MODEL', 'qwen3.8-max' if provider == 'qwen' else 'deepseek-flash')),
            'url': env.get(f'{prefix}_API_URL', env.get(f'{provider_prefix}_API_URL',
                'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions' if provider == 'qwen' else 'https://api.deepseek.com/chat/completions')),
            'api_key': env.get('DASHSCOPE_API_KEY' if provider == 'qwen' else 'DEEPSEEK_API_KEY', '') if provider != 'mock' else '',
            'embedding_key': env.get('DASHSCOPE_API_KEY', '') if provider != 'mock' else '',
        }
        if provider == mode:
            # 同供应商只覆盖模型参数，继续使用主配置中的进程内凭据。
            role_overrides[role].pop('api_key')
            role_overrides[role].pop('embedding_key')
    return Settings(
        mode=mode,
        system_prompt=(ROOT / "system-prompt.md").read_text(encoding="utf-8"),
        consultant_corpus=(ROOT / "consultant-corpus.md").read_text(encoding="utf-8"),
        report_prompt=(ROOT / "report-prompt.md").read_text(encoding="utf-8"),
        model=(env.get("QWEN_MODEL", "qwen3.8-max") if mode == "qwen" else
               env.get("DEEPSEEK_MODEL", "deepseek-flash") if mode == "deepseek" else "mimo-v2.5-pro"),
        url=(env.get("QWEN_API_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions") if mode == "qwen" else
             env.get("DEEPSEEK_API_URL", "https://api.deepseek.com/chat/completions") if mode == "deepseek"
             else env.get("MIMO_API_URL", "https://api.xiaomimimo.com/v1/chat/completions")),
        # mock模式既不使用也不读取Key。
        api_key=(env.get("DASHSCOPE_API_KEY", "") if mode == "qwen" else
                 env.get("DEEPSEEK_API_KEY", "") if mode == "deepseek"
                 else env.get("MIMO_API_KEY", "") if mode == "mimo" else ""),
        codex_model=env.get("CODEX_MODEL", "gpt-6.1-sol"),
        embedding_key=env.get("DASHSCOPE_API_KEY", "") if mode in {"codex", "deepseek", "qwen"} else "",
        rag_index_dir=Path(env["RAG_INDEX_DIR"]) if env.get("RAG_INDEX_DIR") else None,
        rag_chunks_path=Path(env["RAG_CHUNKS_PATH"]) if env.get("RAG_CHUNKS_PATH") else None,
        session_db_path=Path(env['SESSION_DB_PATH']) if env.get('SESSION_DB_PATH') else None,
        role_overrides=role_overrides,
    )
