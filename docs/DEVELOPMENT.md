# 开发与运行

以下说明以 Windows PowerShell 为主。先运行 mock 模式，确认本地工程流程，再单独选择真实模型。依赖版本使用仓库锁文件；其他操作系统的完整流程尚未验收。

## 安装

需要 Python 3.12、Node.js 20 或更新版本。历史环境验证的是 Python 3.12.14。

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-lock.txt
npm ci
```

无需激活 Python 环境，后续命令直接使用 `.venv` 内的解释器。`requirements.txt` 列出直接依赖，`requirements-lock.txt` 冻结既有环境的完整版本。当前 npm 脚本中的 Python 路径也是 Windows 形式。

## 构建后运行完整网站

```powershell
$env:MODEL_MODE = 'mock'
$env:ANALYSIS_PROVIDER = 'mock'
$env:DIALOGUE_PROVIDER = 'mock'
npm run build
.\.venv\Scripts\python.exe -X utf8 -m backend --static --port 9019
```

打开 <http://127.0.0.1:9019/>。`--static` 从 `dist/web/` 提供已经构建的前端；缺少构建结果时先运行 `npm run build`。服务只允许回环监听，默认端口为9000，上例显式改为9019。

mock 模式使用固定离线角色。它可以验证发送、保存、报告兼容和恢复流程，但不会展示真实模型的理解能力。

## 前后端分别开发

在第一个 PowerShell 窗口运行后端：

```powershell
$env:MODEL_MODE = 'mock'
$env:ANALYSIS_PROVIDER = 'mock'
$env:DIALOGUE_PROVIDER = 'mock'
.\.venv\Scripts\python.exe -X utf8 -m backend --port 9000
```

在第二个窗口运行 `npm run dev:web`，打开 Vite 打印的地址。当前 `vite.config.js` 将 `/api` 代理到本机9000端口。

前端的 `VITE_API_BASE` 未设置时使用当前页面 origin。若需要覆盖，应填后端 origin，例如 `http://127.0.0.1:9000`，不要额外附加 `/api`；API Client 会自行拼接 `/api/...`。这是公开的前端构建配置，不能放密钥。

## 真实供应商配置

当前双角色支持 `mock`、`qwen` 和 `deepseek`。下表描述源码中的默认值，不保证外部账户已经开通对应模型。

| 配置 | 用途或默认值 |
| --- | --- |
| `MODEL_MODE` | 默认 `mock` |
| `ANALYSIS_PROVIDER` / `DIALOGUE_PROVIDER` | 显式覆盖角色供应商，否则继承主模式 |
| `ANALYSIS_MODEL` / `DIALOGUE_MODEL` | 分别覆盖角色模型 |
| `ANALYSIS_API_URL` / `DIALOGUE_API_URL` | 分别覆盖完整供应商接口地址 |
| `QWEN_MODEL` | 源码默认 `qwen3.8-max` |
| `QWEN_API_URL` | 源码默认百炼北京兼容接口 |
| `DEEPSEEK_MODEL` | 源码默认 `deepseek-flash` |
| `DEEPSEEK_API_URL` | 源码默认 DeepSeek chat/completions 接口 |
| `DASHSCOPE_API_KEY` | 千问生成和百炼查询向量使用 |
| `DEEPSEEK_API_KEY` | DeepSeek 生成使用 |
| `RAG_INDEX_DIR` | 外部索引目录，内含 `manifest.json` 和 `vectors.jsonl` |
| `RAG_CHUNKS_PATH` | 与索引对应的完整切片文件 |
| `SESSION_DB_PATH` | 显式指定本机会话数据库路径 |

直接 Python 启动入口只读取进程环境，不自动加载 `.env` 或 Windows 加密库。密钥通过本机环境或隐藏输入提供，不写入源码与示例正文。

真实千问可用 `-m backend --static --qwen --port 9018`，真实 DeepSeek 可用 `-m backend --static --deepseek --port 9018`；前置条件是对应凭据已配置，角色覆盖变量与选择一致。若之前设过角色为 mock，可明确设置两个角色为目标供应商，或在当前进程移除角色覆盖变量后继承主模式。

两种真实供应商都执行分析、对话和检查。模型默认请求参数关闭思考模式。通常每轮2次模型请求，最多4次模型和2次检索；实际费用取决于供应商、输入规模和检索使用，工程调用上限不等于固定费用。

### 既有双击启动入口

`start-local.cmd` 调用 `scripts/start-local.ps1`，默认选择千问、端口9018。脚本要求已有 `.venv` 和 `dist/web/`，不安装依赖或构建前端。

`scripts/configure-local-env.ps1` 读取已有进程配置、本机加密库和 Windows 当前用户变量，缺少时隐藏输入。加密配置使用当前 Windows 用户的 DPAPI，保存在 `%LOCALAPPDATA%\AI-Personality-Explorer\keys.clixml`，不能作为仓库配置分发。

只检查配置可用 `-CheckOnly`；缺失或损坏的配置如何处理，以脚本实际输出为准。双击入口不是 mock 启动方式，发送消息后会使用所选真实供应商。

## 资料与检索

作者的94条待审理论向量及切片位于外部知识库，不应假设新克隆仓库已经具备。启动脚本保留作者原工作区的定位逻辑，独立检出应显式配置 `RAG_INDEX_DIR` 和 `RAG_CHUNKS_PATH`。

当前真实模式 CLI 还会无条件读取 `ROOT.parents[3]`，即使提供上述路径也会先执行这一步。仓库根目录不足四层父目录时会在启动阶段失败；mock 不执行这段逻辑。独立检出的真实模式启动仍有这项可移植性待办，不能仅凭 mock 成功推定它已可复现。

索引加载会校验模型、维度、切片 ID、正文和哈希一致性，不应以任意向量文件替代。mock 模式不依赖这些外部数据。

千问/DeepSeek 缺少有效资料时仍可普通交流，检索返回不可用；旧 Codex 模式对快照有额外前置要求。理论分析资料与沟通案例分开，当前没有配置沟通案例库。

## 本机数据

默认数据库是 `%LOCALAPPDATA%\AI-Personality-Explorer\consultations.sqlite3`，不在静态资源目录。若需要独立试用库，应在启动前设置自己的 `SESSION_DB_PATH`，不要复用真实咨询库做测试。

浏览器保留未发送草稿、恢复标识和旧历史。旧记录只有在用户选择继续时才导入，原件保留。恢复中出现版本冲突或断流，应查询原请求；不要通过重复创建请求绕过冲突。

## 离线检查

```powershell
$env:MODEL_MODE = 'mock'
$env:ANALYSIS_PROVIDER = 'mock'
$env:DIALOGUE_PROVIDER = 'mock'
.\.venv\Scripts\python.exe -X utf8 -m pytest tests/python -q --basetemp=.pytest-tmp/docs-check
npm run build
npm run test:node
npm run typecheck
npm run test:browser
```

Node静态服务回归需要已有`dist/web/`，因此先构建。浏览器测试使用本机 Microsoft Edge，现有启动器不会下载浏览器。相关恢复用例使用临时 SQLite 与本机 mock 后端，不使用个人咨询库。测试结果及解释边界见[评测说明](EVALUATION.md)。

## 最小会话 API 示例

先启动 mock 后端，再在另一窗口运行以下 PowerShell。示例会创建一段新的模拟咨询，不使用真实模型。

```powershell
$apiOrigin = 'http://127.0.0.1:9019'
$demoSessionId = [guid]::NewGuid().ToString()
$sessionBody = @{ session = @{ id = $demoSessionId } } | ConvertTo-Json -Depth 6
$created = Invoke-RestMethod -Method Post -Uri "$apiOrigin/api/sessions" -ContentType 'application/json; charset=utf-8' -Body $sessionBody

$turnBody = @{
    request_id = [guid]::NewGuid().ToString()
    expected_revision = $created.session.revision
    message = '我想梳理最近一次拖延的经历。'
    stream = $false
} | ConvertTo-Json -Depth 6
$result = Invoke-RestMethod -Method Post -Uri "$apiOrigin/api/sessions/$demoSessionId/turns" -ContentType 'application/json; charset=utf-8' -Body $turnBody
$result.reply
```

## 常见问题

| 现象 | 检查方向 |
| --- | --- |
| 页面或素材缺失 | 是否在正确项目根目录执行过 `npm run build`，是否带 `--static` |
| Vite 页面无法访问 API | 开发后端是否在9000端口，代理和 `VITE_API_BASE` 是否匹配 |
| 回复显示“本地模拟” | 两个角色的 provider 是否仍为 mock |
| 第二个后端无法持有数据库 | 原服务是否还在使用同一个 `SESSION_DB_PATH` |
| 普通对话可用但无法检索 | 外部快照路径、哈希、角色 scope 与 embedding 配置 |
| 请求中断后不知道是否完成 | 用原 session/request ID 查询，再决定恢复或重试 |
| 413 或内容过长 | 单条8000字符、含入口与回复预留最多60条，另受160000字节请求体限制 |

部署 Python 运行时需要单独准备，历史 `scf_bootstrap` 和 `build_deploy_zip.py` 仍是 Node 方案。
