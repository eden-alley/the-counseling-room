"""一轮的两个角色共用预算，失败路径不能重新取得额度。"""
import importlib
import pytest

from backend.model_client import ModelError


def budget(**kwargs):
    return importlib.import_module('backend.agent.budget').TurnBudget(**kwargs)


def test_roles_share_four_model_calls_but_each_stops_at_two():
    value = budget()
    value.use_model('analysis')
    value.use_model('analysis')
    with pytest.raises(ModelError, match='次数'):
        value.use_model('analysis')
    value.use_model('dialogue')
    value.use_model('dialogue')
    with pytest.raises(ModelError, match='次数'):
        value.use_model('dialogue')
    assert value.summary() == {
        'model_requests': 4, 'retrieval_attempts': 0,
        'roles': {'analysis': {'model_requests': 2, 'retrieval_attempts': 0},
                  'dialogue': {'model_requests': 2, 'retrieval_attempts': 0}},
    }


def test_failed_tool_attempt_is_not_refunded():
    value = budget()
    value.use_tool('analysis')  # The caller subsequently rejects bad arguments.
    with pytest.raises(ModelError, match='检索'):
        value.use_tool('analysis')
    value.use_tool('dialogue')
    with pytest.raises(ModelError, match='检索'):
        value.use_tool('dialogue')
    assert value.summary()['retrieval_attempts'] == 2


def test_deadline_applies_to_both_roles_and_tools():
    current = [100.0]
    value = budget(clock=lambda: current[0])
    value.use_model('analysis')
    current[0] = 280.0
    for action in [lambda: value.use_model('dialogue'), lambda: value.use_tool('analysis')]:
        with pytest.raises(ModelError) as error:
            action()
        assert error.value.status == 504
    assert value.summary()['model_requests'] == 1


def test_real_utf8_payload_bytes_are_bounded_without_truncation():
    value = budget()
    accepted = value.encode_payload({'x': '汉' * 53330})
    assert len(accepted) == 159998
    assert accepted.decode('utf-8').endswith('汉"}')
    with pytest.raises(ModelError) as error:
        value.encode_payload({'x': '汉' * 53331})
    assert error.value.status == 413
