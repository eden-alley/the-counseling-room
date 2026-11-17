# Load saved keys, then start the existing backend. No model call at startup.
[CmdletBinding()]
param(
    [ValidateRange(1024,65535)][int]$Port = 9018,
    [ValidateSet('qwen', 'deepseek')][string]$Provider = 'qwen'
)
$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $projectDirectory
try {
    if (-not (Test-Path -LiteralPath '.\.venv\Scripts\python.exe')) { throw 'Project Python environment is missing.' }
    if (-not (Test-Path -LiteralPath '.\dist\web\index.html')) { throw 'Frontend build is missing; run npm run build first.' }
    & "$PSScriptRoot\configure-local-env.ps1"
    & '.\.venv\Scripts\python.exe' -X utf8 -m backend --static "--$Provider" --port $Port
}
finally { Pop-Location }
