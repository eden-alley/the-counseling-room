"""数据结构与来源校验：索引有效不等于经历已被外部核实。"""
from typing import Annotated, Literal, TypedDict
from pydantic import BaseModel, ConfigDict, Field, StringConstraints

ShortText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=600)]
MessageText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=8000)]
Index = Annotated[int, Field(strict=True, ge=0)]
References = Annotated[list[Index], Field(max_length=60)]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Message(StrictModel):
    role: Literal["user", "assistant"]
    content: MessageText


class ChatRequest(StrictModel):
    messages: Annotated[list[Message], Field(min_length=1, max_length=60)]
    stream: bool = False


class Answer(StrictModel):
    question: Annotated[str, Field(max_length=1000)]
    answer: Annotated[str, Field(max_length=4000)]


class ReportRequest(ChatRequest):
    answers: Annotated[list[Answer], Field(max_length=3)] = Field(default_factory=list)


class Goal(StrictModel):
    text: ShortText
    confirmed: bool
    evidence: References


class Statement(StrictModel):
    text: ShortText
    kind: Literal["report", "interpretation"]
    evidence: Annotated[References, Field(min_length=1)]


class Hypothesis(StrictModel):
    text: ShortText
    support: References
    against: References
    alternative: ShortText | None
    status: Literal["tentative", "revised"]


class Assessment(StrictModel):
    goal: Goal | None
    statements: Annotated[list[Statement], Field(max_length=30)]
    hypotheses: Annotated[list[Hypothesis], Field(max_length=8)]
    strategy: Literal["reflect", "clarify", "explore", "challenge", "summarize", "respect_boundary"]


def validate_assessment(value: Assessment, messages: list[dict]) -> Assessment:
    # 再验一次，避免注入的适配器绕过Schema校验。
    result = Assessment.model_validate(value.model_dump() if isinstance(value, Assessment) else value)
    indexes = list(result.goal.evidence) if result.goal else []
    for statement in result.statements:
        indexes.extend(statement.evidence)
    for hypothesis in result.hypotheses:
        indexes.extend(hypothesis.support + hypothesis.against)
    if any(index >= len(messages) or messages[index]["role"] != "user" for index in indexes):
        raise ValueError("引用必须指向已有的用户消息")
    if result.goal and result.goal.confirmed and not result.goal.evidence:
        raise ValueError("已确认目标必须有用户依据")
    return result


class ConsultationState(TypedDict):
    # TypedDict 描述图状态的字段类型，不自行执行运行时校验。
    # 实际校验由上面的 Pydantic 模型与 validate_assessment 完成。
    # 未使用 MessagesState/add_messages；messages 是本次请求传来的完整历史。
    messages: list[dict]
    assessment: dict | None
    reply: str
    failure: dict | None


# 双角色协议独立于旧 ChatRequest/ReportRequest，避免破坏兼容入口。
StableId = Annotated[str, StringConstraints(min_length=1, max_length=200)]


class Evidence(StrictModel):
    message_id: StableId
    quote: Annotated[str, StringConstraints(min_length=1, max_length=2000)]


Quotes = Annotated[list[Evidence], Field(max_length=20)]


class EvidenceGoal(StrictModel):
    text: ShortText
    confirmed: bool
    evidence: Quotes


class AnalysisStatement(StrictModel):
    id: StableId
    text: ShortText
    kind: Literal['report', 'interpretation']
    status: Literal['active', 'withdrawn']
    evidence: Annotated[Quotes, Field(min_length=1)]
    revision_reason: ShortText | None = None


class AnalysisHypothesis(StrictModel):
    id: StableId
    text: ShortText
    support: Quotes
    against: Quotes
    alternative: ShortText | None
    status: Literal['tentative', 'revised', 'withdrawn', 'needs_review']
    depends_on: Annotated[list[StableId], Field(max_length=30)]
    revision_reason: ShortText | None = None


class AnalysisBrief(StrictModel):
    goal: EvidenceGoal | None
    statements: Annotated[list[AnalysisStatement], Field(max_length=30)]
    hypotheses: Annotated[list[AnalysisHypothesis], Field(max_length=8)]
    boundaries: Annotated[list[ShortText], Field(max_length=20)]
    unknowns: Annotated[list[ShortText], Field(max_length=20)]
    exploration: ShortText | None


class DialogueTurn(StrictModel):
    reply: MessageText
    action: Literal['acknowledge', 'reflect', 'affirm', 'answer', 'clarify', 'explore',
                    'summarize', 'respect_boundary']
    questions: Annotated[list[ShortText], Field(max_length=1)]
    analysis_response: Literal['adopted', 'deferred', 'disagreed', 'none']
    feedback: ShortText
    evidence: Quotes


class SessionState(StrictModel):
    version: Annotated[int, Field(ge=0)] = 0
    goal: EvidenceGoal | None = None
    statements: list[AnalysisStatement] = Field(default_factory=list)
    hypotheses: list[AnalysisHypothesis] = Field(default_factory=list)
    boundaries: list[ShortText] = Field(default_factory=list)
    unknowns: list[ShortText] = Field(default_factory=list)
    last_dialogue: DialogueTurn | None = None
    withdrawn_at: dict[str, int] = Field(default_factory=dict)
    # 程序生成的修订事件和资料引用，模型不能直接覆盖。
    revisions: list[dict] = Field(default_factory=list)
    materials: list[dict] = Field(default_factory=list)


def validate_quotes(evidence: list[Evidence], messages: list[dict]) -> None:
    by_id = {message['id']: message for message in messages}
    for ref in evidence:
        source = by_id.get(ref.message_id)
        if not source or source['role'] != 'user' or ref.quote not in source['content']:
            raise ValueError('依据必须定位到实际用户原文')


def merge_analysis(brief: AnalysisBrief, previous: dict | None, messages: list[dict]) -> dict:
    """保留未提及条目；显式撤回和依赖失效由程序处理，不证明语义真假。"""
    brief = AnalysisBrief.model_validate(brief.model_dump())
    prior = SessionState.model_validate(previous or {}).model_dump()
    result = SessionState.model_validate(prior).model_dump()  # 不修改输入快照。
    result['version'] += 1
    positions = {message['id']: index for index, message in enumerate(messages) if message['role'] == 'user'}
    if brief.goal:
        validate_quotes(brief.goal.evidence, messages)
        if brief.goal.confirmed and not brief.goal.evidence:
            raise ValueError('确认目标必须有用户原文依据')

    old = {entry['id']: entry for group in ('statements', 'hypotheses') for entry in prior[group]}
    incoming_ids = [entry.id for entry in [*brief.statements, *brief.hypotheses]]
    if len(set(incoming_ids)) != len(incoming_ids):
        raise ValueError('条目 ID 重复')
    for group in ('statements', 'hypotheses'):
        entries = {entry['id']: entry for entry in result[group]}
        other_ids = {entry['id'] for entry in result['hypotheses' if group == 'statements' else 'statements']}
        for item in getattr(brief, group):
            if item.id in other_ids:
                raise ValueError('条目类型不能通过重复 ID 改写')
            refs = item.evidence if group == 'statements' else [*item.support, *item.against]
            validate_quotes(refs, messages)
            earlier = old.get(item.id)
            if earlier and earlier['status'] in {'withdrawn', 'needs_review'} and item.status not in {'withdrawn', 'needs_review'}:
                cutoff = result['withdrawn_at'].get(item.id, len(messages) - 1)
                if not item.revision_reason or not any(positions.get(ref.message_id, -1) > cutoff for ref in refs):
                    raise ValueError('重新启用需要撤回之后的新用户证据及修订理由')
            if item.status in {'withdrawn', 'needs_review'} and (not earlier or earlier['status'] != item.status):
                result['withdrawn_at'][item.id] = len(messages) - 1
            entries[item.id] = item.model_dump()
        result[group] = list(entries.values())

    combined = {entry['id']: entry for group in ('statements', 'hypotheses') for entry in result[group]}
    visiting, visited = set(), set()

    def check_dependencies(entry_id):
        if entry_id in visiting:
            raise ValueError('条目依赖成环')
        if entry_id in visited:
            return
        visiting.add(entry_id)
        for dependency in combined[entry_id].get('depends_on', []):
            if dependency not in combined:
                raise ValueError('条目依赖不存在')
            check_dependencies(dependency)
        visiting.remove(entry_id)
        visited.add(entry_id)

    for entry_id in combined:
        check_dependencies(entry_id)
    changed = True
    while changed:
        changed = False
        for item in result['hypotheses']:
            if item['status'] not in {'withdrawn', 'needs_review'} and any(
                    combined[ref]['status'] in {'withdrawn', 'needs_review'} for ref in item['depends_on']):
                item['status'] = 'needs_review'
                item['revision_reason'] = '依赖条目已撤回或待复核。'
                result['withdrawn_at'][item['id']] = len(messages) - 1
                changed = True
    for entry_id, entry in combined.items():
        if old.get(entry_id) != entry:
            result['revisions'].append({'version': result['version'], 'id': entry_id,
                                        'before': old.get(entry_id), 'after': entry.copy()})
    result.update(goal=brief.goal.model_dump() if brief.goal else None,
                  boundaries=list(brief.boundaries), unknowns=list(brief.unknowns))
    return SessionState.model_validate(result).model_dump()


class DualState(TypedDict):
    messages: list[dict]
    entry_context: str
    previous_state: dict | None
    analysis: dict
    dialogue: dict
    session_state: dict
    result: dict
