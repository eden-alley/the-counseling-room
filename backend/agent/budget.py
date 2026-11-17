"""每轮只有一份预算；角色、工具和供应商不得自行重置。"""
import json
import time

from ..model_client import ModelError


class TurnBudget:
    def __init__(self, *, timeout=180.0, max_body_bytes=160_000, clock=time.monotonic):
        self._clock = clock
        self.deadline = clock() + timeout
        self.max_body_bytes = max_body_bytes
        self._roles = {name: {'model_requests': 0, 'retrieval_attempts': 0}
                       for name in ('analysis', 'dialogue')}

    def remaining(self):
        seconds = self.deadline - self._clock()
        if seconds <= 0:
            raise ModelError('本轮回复超时，已停止。', 504)
        return seconds

    def use_model(self, role):
        self.remaining()
        if role not in self._roles:
            raise ValueError('Unknown role')
        if self._roles[role]['model_requests'] >= 2 or self.summary()['model_requests'] >= 4:
            raise ModelError('本轮模型调用次数已达上限。')
        self._roles[role]['model_requests'] += 1

    def use_tool(self, role):
        self.remaining()
        if role not in self._roles:
            raise ValueError('Unknown role')
        if self._roles[role]['retrieval_attempts'] >= 1 or self.summary()['retrieval_attempts'] >= 2:
            raise ModelError('本轮检索次数已达上限。')
        self._roles[role]['retrieval_attempts'] += 1

    def encode_payload(self, payload):
        """返回将实际发送的字节，不能用字符数估算或截断提示词。"""
        self.remaining()
        encoded = json.dumps(payload, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')
        if len(encoded) > self.max_body_bytes:
            raise ModelError('本轮组装后的内容过长，请保存并结束本次咨询。', 413)
        return encoded

    def summary(self):
        return {
            'model_requests': sum(item['model_requests'] for item in self._roles.values()),
            'retrieval_attempts': sum(item['retrieval_attempts'] for item in self._roles.values()),
            'roles': {role: dict(value) for role, value in self._roles.items()},
        }
