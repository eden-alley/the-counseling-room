# Python 后端阅读入口

本目录是当前本地后端。完整启动与配置见[开发说明](../docs/DEVELOPMENT.md)，系统流程见[架构说明](../docs/ARCHITECTURE.md)，验证范围见[评测说明](../docs/EVALUATION.md)。

## 先读哪几个文件

1. [agent/graph.py](agent/graph.py)：从 `DualCounselor` 的构造函数看固定节点和连线，再看 `run_turn`、`analyze`、`respond`、`check`。
2. [agent/state.py](agent/state.py)：角色输出、原话证据、稳定 ID、撤回与依赖合并。
3. [agent/prompts.py](agent/prompts.py)：两个角色怎样接收原文、前次状态和沟通反馈。
4. [agent/runtime.py](agent/runtime.py) 与 [agent/budget.py](agent/budget.py)：模型/工具回路和全轮预算。
5. [session_api.py](session_api.py) 与 [session_store.py](session_store.py)：请求去重、版本、事务、快照与恢复。
6. [api.py](api.py)、[config.py](config.py) 和 [__main__.py](__main__.py)：应用接线、角色配置与命令行入口。
7. [deepseek_client.py](deepseek_client.py) 与 [retrieval.py](retrieval.py)：供应商单次请求和有范围的资料检索。

## 最短无费用启动

在项目根目录、已经安装依赖并构建前端后执行：

```powershell
$env:MODEL_MODE = 'mock'
$env:ANALYSIS_PROVIDER = 'mock'
$env:DIALOGUE_PROVIDER = 'mock'
.\.venv\Scripts\python.exe -X utf8 -m backend --static --port 9019
```

访问 <http://127.0.0.1:9019/>。默认数据库是 `%LOCALAPPDATA%\AI-Personality-Explorer\consultations.sqlite3`；独立测试请显式指定临时 `SESSION_DB_PATH`。

## 当前路径与兼容路径

mock、千问、DeepSeek 咨询使用 `DualCounselor`。通常分析和对话各请求一次模型，最多4次模型请求和2次检索，共享180秒；结果检查并原子保存后交付。

`graph.py` 中旧 `Counselor` 的 understand/respond/check、MiMo、Codex 和旧报告回路保留兼容职责。阅读当前咨询时从 `DualCounselor` 开始，阅读报告时再看旧 `complete` 路径。

`async def` 表示函数可能等待，`await` 让网络等待不阻塞其他协程；固定图管理角色顺序，工具回路管理单个角色有限的检索过程。它们与 SSE 搬运事件的循环承担不同职责。

## 验证

```powershell
.\.venv\Scripts\python.exe -X utf8 -m pytest tests/python -q --basetemp=.pytest-tmp/backend-check
```

工程测试使用离线角色、HTTP 替身与临时数据库，不能代替真实多轮咨询质量评审。历史 Node 启动器和打包器不适用于部署本目录。
