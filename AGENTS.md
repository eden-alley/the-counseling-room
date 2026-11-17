# The Counseling Room 协作入口

先读 [README.md](README.md) 和[当前状态](docs/STATUS.md)，按任务加载对应说明，不预先扫描全部历史材料。

在作者原知识库工作区中，仍须遵守适用的上层 `AGENTS.md` 与内部项目中控规则；独立仓库中的阅读入口使用本文件列出的相对路径。

## 按任务读取

| 任务 | 文档与代码入口 |
| --- | --- |
| 产品讨论 | `docs/PRODUCT.md`、`docs/STATUS.md` |
| 咨询 Agent | `docs/ARCHITECTURE.md`、`docs/EVALUATION.md`、`backend/agent/` |
| API 与保存 | `backend/session_api.py`、`backend/session_store.py`、`shared/contracts/` |
| 前端 | `src/client/`、相关 unit/browser 测试 |
| 开发与检查 | `docs/DEVELOPMENT.md` |
| GitHub 发布准备 | `docs/PUBLISHING.md` |

## 工作边界

- 保留已有修改和未跟踪文件，修改前查看 Git 状态。
- 修改前说明精确文件、行为影响和验证方式，按当前任务授权及适用规则执行；原知识库的逐项确认规则继续适用。
- 不创建第二套并行代码源，不清理无关文件，不使用批量还原或笼统暂存。
- 未获授权不提交、推送、部署、切流或写入外部系统。
- 真实模型、embedding 或其他付费调用前明确目的、次数与费用并获准。
- 不读取或展示个人咨询库和凭据来做测试；测试使用离线角色、HTTP 替身和临时数据库。
- 不扩展跨咨询画像、账号或云端同步，不自行增加语料准入与报告产品设计。
- 保持临时退出与正式结束两条流程；八维只是可选解释工具。
- 文档变更检查链接和事实；代码变更运行与风险匹配的检查，只报告实际执行的结果。

当前本地后端是 `backend/`。`server/`、旧报告和 MiMo/Codex 兼容路径应按实际职责理解，不把历史说明当成当前双角色实现。
