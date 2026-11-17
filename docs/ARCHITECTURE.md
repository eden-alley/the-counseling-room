# 架构与会话协议

当前本地运行路径是 Vite 前端直接访问 Python FastAPI。Node.js 用于前端工具和保留的历史回归，默认 API 请求不经过 Node 转发。

## 一轮咨询的调用链

```text
浏览器 session-repository
  → /api/sessions/{sid}/turns
  → SessionStore.begin_turn：登记原文和 request_id
  → DualCounselor.run_turn
      → analysis：整理理解与假设
      → dialogue：决定回应并留下反馈
      → check：检查结构、引用和公开回复
  → SessionStore.complete_turn：原子保存完整结果
  → 公开 JSON 或 SSE
```

固定图由 `backend/agent/graph.py` 的 `DualCounselor` 构造。模型只在事务外执行，数据库事务不跨越模型网络请求。

## 两个角色的职责

| 角色 | 主要输入 | 主要输出 | 检索范围 |
| --- | --- | --- | --- |
| analysis | 完整原文、上轮状态与沟通反馈、入口背景 | `AnalysisBrief` | `search_analysis_material` |
| dialogue | 完整原文、合并后的理解、分析建议 | `DialogueTurn` | `search_dialogue_material` |
| 程序检查 | 角色输出、原文与预算信息 | 可落盘的完整结果 | 不调用模型 |

`AnalysisBrief` 包含目标、自述与解释条目、假设、边界、未知项和探索建议。`DialogueTurn` 包含公开回复、主要动作、零到一个问题，以及采用、暂缓或反对分析建议的反馈。

对话角色不能直接改写分析条目；反馈保存在 `SessionState.last_dialogue`，供下一轮分析处理。系统不保存或展示供应商隐藏推理。

## 状态和依据

用户消息与理解条目具有稳定 ID。证据由 `message_id` 和用户原话 `quote` 组成；程序校验引用是否来自真实用户消息，以及原话是否存在。

用户自述标为 `report`，用户解释标为 `interpretation`。假设保留支持、反证、替代解释及 `depends_on` 依赖。撤回条目后，依赖它的判断进入 `needs_review`；重新启用需要更新的用户证据与修订理由。

这些检查能约束数据结构和引用，不能证明假设在语义上正确。

## 工具回路和预算

`backend/agent/runtime.py` 为两个角色执行同一种有限工具回路。每次供应商请求由 `complete_once` 发出，工具正文和出处作为 `role: tool` 消息进入下一次请求。

| 限制 | 当前实现 |
| --- | --- |
| 普通一轮模型请求 | 通常2次，分析和对话各1次 |
| 每个角色 | 最多2次模型请求、1次检索 |
| 全轮合计 | 最多4次模型请求、2次检索 |
| 全轮期限 | 共享180秒 |
| 单次分析输出上限 | 2400 token |
| 单次对话输出上限 | 1200 token |
| 实际供应商请求体 | 最多160000字节 |
| 自动重试和额外 JSON 修复 | 新双角色路径均不执行 |

检索先按 `analysis` 或 `dialogue` 范围过滤，再进行排序。现有理论快照默认归属 analysis；dialogue 没有案例资料时返回 `unavailable`，不发送该次查询向量请求。资料不可用不阻断普通交流。

## SQLite 与恢复

标准库 SQLite 使用 `sessions`、`messages`、`turns` 三表保存同一咨询。数据库是已接收会话的状态来源，不同时启用第二套 LangGraph checkpointer。

- `request_id` 识别同一次请求，避免重复生成。
- `expected_revision` 防止旧版本覆盖新状态。
- 成功结果完整保存后才交付回复；失败保留已接收的用户原文。
- 后端重启把遗留 `pending` 标为 `interrupted`，不自动再次调用模型。
- 断流后先查询原请求；已完成则恢复结果，失败或中断时由用户决定重试。
- 主动保存建立快照；丢弃续聊恢复该快照，并继续递增修订号。
- 删除或丢弃新会话保留无正文标记，防止迟到结果让记录复活。

`saved` 表示当前修订已经主动保存，`hasSavedSnapshot` 表示存在主动保存快照。后者让尚未保存的新续聊不会隐藏已有历史。

文件数据库由服务生命周期的操作系统锁保护，同一路径只允许一个服务持有。默认监听回环地址，会话接口检查本机 Host 和 Origin；这不是账号认证或公开多用户方案。

## API 概览

| 方法和路径 | 用途 |
| --- | --- |
| `GET /api/health` | 服务状态与能力 |
| `POST /api/sessions` | 创建会话，正文为 `{session: {id, ...}}` |
| `POST /api/sessions/import` | 显式导入旧公开记录 |
| `GET /api/sessions` | 列出会话 |
| `GET /api/sessions/{sid}` | 读取会话 |
| `POST /api/sessions/{sid}/turns` | 提交本轮用户消息 |
| `GET /api/sessions/{sid}/turns/{rid}` | 查询原请求结果 |
| `POST /api/sessions/{sid}/turns/{rid}/cancel` | 取消在途请求 |
| `POST /api/sessions/{sid}/save` | 主动保存当前修订 |
| `POST /api/sessions/{sid}/discard` | 丢弃未保存内容 |
| `POST /api/sessions/{sid}/metadata` | 更新会话元数据 |
| `DELETE /api/sessions/{sid}` | 删除会话 |

轮次正文包含 `request_id`、`expected_revision`、`message`，以及可选的 `retry_of`、`stream`。其他写入的精确字段以 `backend/session_api.py` 的请求模型为准。

新会话 SSE 事件为 `accepted/delta/done/error`。`accepted` 表示请求和用户原文已登记；完整结果保存后才发送回复。目前通常用一个 `delta` 交付完整回复，不能据此称为逐 token 流式生成。

前端仅收到公开消息、回复与生命周期字段，不收到内部分析、沟通反馈、工具正文或用量。旧 `/api/chat` 和 `/api/report/audit`、`/api/report/generate` 保留兼容协议；MiMo/Codex 与报告路径不属于新双角色完整恢复的验收对象。

## 源码定位

| 文件 | 责任 |
| --- | --- |
| `backend/api.py` | 应用与供应商接线、兼容聊天和报告 |
| `backend/session_api.py` | 会话协议、生命周期、取消和公开投影 |
| `backend/session_store.py` | 事务、版本、原文与快照 |
| `backend/agent/graph.py` | 双角色固定图 |
| `backend/agent/state.py` | 输出模型、引用与状态合并 |
| `backend/agent/prompts.py` | 原文、状态与角色约束的上下文组织 |
| `backend/agent/runtime.py` | 有限模型与工具回路 |
| `backend/agent/budget.py` | 共享调用、时间与请求体预算 |
| `backend/deepseek_client.py` | 千问/DeepSeek 单次请求与旧报告兼容 |
| `src/client/infrastructure/session-repository.js` | 前端恢复、旧记录导入与异步存取 |

旧 `server/`、`app.js`、`scf_bootstrap` 和打包器保留历史用途，不能直接用于部署当前 Python 后端。
