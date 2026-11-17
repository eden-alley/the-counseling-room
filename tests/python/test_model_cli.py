"""启动参数只接线和核验本地快照；本测试不启动HTTP服务或调用供应商。"""
import sys
from pathlib import Path

import pytest

from backend import __main__ as cli
from backend import retrieval


def setup_cli(monkeypatch, args):
    seen = {}
    monkeypatch.setattr(sys, 'argv', ['backend', *args])
    monkeypatch.setenv('MODEL_MODE', 'mock')
    monkeypatch.setenv('DEEPSEEK_API_KEY', 'process-deepseek-key')
    monkeypatch.setenv('DASHSCOPE_API_KEY', 'process-embedding-key')
    monkeypatch.setenv('DEEPSEEK_MODEL', 'deepseek-flash')
    monkeypatch.setenv('SESSION_DB_PATH', str(Path.cwd() / '.pytest-tmp' / 'cli-fixture' / 'consultations.sqlite3'))
    def snapshot(index, chunks, *, api_key):
        seen['snapshot'] = (index, chunks, api_key)
    monkeypatch.setattr(retrieval, 'DraftRetriever', snapshot)
    def app(**kwargs):
        seen.update(kwargs)
        return 'app'
    monkeypatch.setattr(cli, 'create_app', app)
    monkeypatch.setattr(cli.uvicorn, 'run', lambda *args, **kwargs: seen.update(server=kwargs))
    return seen


def test_deepseek_flag_reads_existing_environment_and_selects_default_index(monkeypatch, capsys):
    seen = setup_cli(monkeypatch, ['--deepseek'])
    cli.main()
    settings = seen['settings']
    assert settings.mode == 'deepseek' and settings.model == 'deepseek-flash'
    assert settings.api_key == 'process-deepseek-key'
    assert settings.embedding_key == 'process-embedding-key'
    assert seen['snapshot'][0].name == 'rag-experiment-2026-10-22'
    assert seen['snapshot'][1].name == 'chunks.jsonl'
    assert seen['server']['host'] == '127.0.0.1'
    output = capsys.readouterr().out
    assert 'process-deepseek-key' not in output and 'process-embedding-key' not in output


def test_missing_deepseek_key_stops_before_server_start(monkeypatch):
    seen = setup_cli(monkeypatch, ['--deepseek'])
    monkeypatch.delenv('DEEPSEEK_API_KEY')
    with pytest.raises(SystemExit):
        cli.main()
    assert 'server' not in seen and 'snapshot' not in seen


def test_hidden_key_prompts_are_process_local(monkeypatch):
    seen = setup_cli(monkeypatch, ['--deepseek', '--deepseek-key-prompt', '--embedding-key-prompt'])
    values = iter(['hidden-chat', 'hidden-embedding'])
    monkeypatch.setattr(cli, 'getpass', lambda prompt: next(values))
    cli.main()
    assert seen['settings'].api_key == 'hidden-chat'
    assert seen['settings'].embedding_key == 'hidden-embedding'
    assert cli.os.environ['DEEPSEEK_API_KEY'] == 'process-deepseek-key'


def test_deepseek_and_codex_flags_cannot_be_combined(monkeypatch):
    seen = setup_cli(monkeypatch, ['--deepseek', '--codex'])
    with pytest.raises(SystemExit):
        cli.main()
    assert not seen


def test_mock_persistent_cli_rejects_non_loopback_host(monkeypatch):
    seen = setup_cli(monkeypatch, ['--host', '0.0.0.0'])
    with pytest.raises(SystemExit):
        cli.main()
    assert 'server' not in seen


def test_deepseek_without_embedding_key_can_start_normal_chat(monkeypatch):
    seen = setup_cli(monkeypatch, ['--deepseek'])
    monkeypatch.delenv('DASHSCOPE_API_KEY')
    cli.main()
    assert seen['settings'].mode == 'deepseek' and 'server' in seen
    assert seen['settings'].session_db_path.name == 'consultations.sqlite3'
    assert 'snapshot' not in seen


def test_default_session_location_is_outside_code(monkeypatch, tmp_path):
    seen = setup_cli(monkeypatch, [])
    monkeypatch.delenv('SESSION_DB_PATH')
    monkeypatch.setenv('LOCALAPPDATA', str(tmp_path))
    cli.main()
    assert seen['settings'].session_db_path == tmp_path / 'AI-Personality-Explorer' / 'consultations.sqlite3'


def test_bad_optional_snapshot_does_not_block_model_start(monkeypatch, capsys):
    seen = setup_cli(monkeypatch, ['--deepseek'])
    def bad_snapshot(*args, **kwargs):
        raise retrieval.RetrievalError('private-file-path')
    monkeypatch.setattr(retrieval, 'DraftRetriever', bad_snapshot)
    cli.main()
    assert 'server' in seen
    assert 'private-file-path' not in capsys.readouterr().out
