# Run in the PowerShell window that will start the backend.
# Windows DPAPI encrypted storage; no plaintext files or API calls.
[CmdletBinding()]
param(
    [switch]$CheckOnly,
    [switch]$NoPrompt,
    [string]$StorePath = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'AI-Personality-Explorer\keys.clixml')
)

$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Encrypted key storage requires Windows DPAPI.' }
$keyNames = @('DEEPSEEK_API_KEY', 'DASHSCOPE_API_KEY')
$resolvedKeys = @{}
$storedKeys = @{}
$mustSave = $false

try {
    if (Test-Path -LiteralPath $StorePath) {
        try {
            $storedKeys = Import-Clixml -LiteralPath $StorePath -ErrorAction Stop
            if ($storedKeys -isnot [System.Collections.IDictionary]) { throw 'Invalid store' }
            foreach ($name in $keyNames) {
                if (-not $storedKeys.Contains($name) -or $storedKeys[$name] -isnot [Security.SecureString] -or $storedKeys[$name].Length -eq 0) {
                    throw 'Invalid secret type'
                }
            }
        }
        catch { throw 'Cannot decrypt local key store. Use the original Windows user; the store was not overwritten.' }
    }
    foreach ($keyName in $keyNames) {
        $keyValue = [Environment]::GetEnvironmentVariable($keyName, 'Process')
        $keySource = 'Process'
        if ([string]::IsNullOrWhiteSpace($keyValue) -and $storedKeys.Contains($keyName)) {
            $keyValue = [System.Net.NetworkCredential]::new('', $storedKeys[$keyName]).Password
            $keySource = 'EncryptedStore'
        }
        if ([string]::IsNullOrWhiteSpace($keyValue)) {
            $keyValue = [Environment]::GetEnvironmentVariable($keyName, 'User')
            $keySource = 'User'
        }
        if ([string]::IsNullOrWhiteSpace($keyValue)) {
            $keySource = 'Missing'
        }
        $resolvedKeys[$keyName] = $keyValue
        if ($keySource -ne 'EncryptedStore') { $mustSave = $true }
        if ($CheckOnly) {
            [pscustomobject]@{
                Variable = $keyName
                Configured = ($keySource -ne 'Missing')
                Source = $keySource
            }
        }
    }
    if ($CheckOnly) { return }

    # Collect both keys before changing the process environment.
    foreach ($keyName in $keyNames) {
        if ([string]::IsNullOrWhiteSpace($resolvedKeys[$keyName])) {
            if ($NoPrompt) { throw "$keyName is missing. Run configure-local-env.ps1 once to save it." }
            $hiddenValue = Read-Host "$keyName (hidden input; saved encrypted for future starts)" -AsSecureString
            try {
                $keyValue = [System.Net.NetworkCredential]::new('', $hiddenValue).Password
                if ([string]::IsNullOrWhiteSpace($keyValue)) {
                    throw "$keyName is empty. Configuration cancelled; no environment changes made."
                }
                $resolvedKeys[$keyName] = $keyValue.Trim()
            }
            finally {
                if ($null -ne $hiddenValue) { $hiddenValue.Dispose() }
            }
        }
    }
    if ($mustSave) {
        $encryptedKeys = @{}
        $storeDirectory = Split-Path -Parent ([IO.Path]::GetFullPath($StorePath))
        [void][IO.Directory]::CreateDirectory($storeDirectory)
        $temporaryStore = Join-Path $storeDirectory ([Guid]::NewGuid().ToString() + '.tmp')
        try {
            foreach ($keyName in $keyNames) {
                $encryptedKeys[$keyName] = [System.Net.NetworkCredential]::new('', $resolvedKeys[$keyName]).SecurePassword
            }
            $encryptedKeys | Export-Clixml -LiteralPath $temporaryStore -ErrorAction Stop
            Move-Item -LiteralPath $temporaryStore -Destination $StorePath -Force -ErrorAction Stop
        }
        finally {
            foreach ($secret in $encryptedKeys.Values) { $secret.Dispose() }
            if (Test-Path -LiteralPath $temporaryStore) { Remove-Item -LiteralPath $temporaryStore }
        }
    }
    foreach ($keyName in $keyNames) {
        [Environment]::SetEnvironmentVariable($keyName, $resolvedKeys[$keyName], 'Process')
    }
    Write-Host 'Keys saved with Windows user encryption and loaded for this process. No API request was sent.'
    Write-Host 'MODEL_MODE is unchanged; live mode still requires explicit selection.'
    Write-Host 'Future starts (no repeated key entry): .\scripts\start-local.ps1'
}
finally {
    $resolvedKeys.Clear()
    $keyValue = $null
    $hiddenValue = $null
    foreach ($secret in $storedKeys.Values) {
        if ($secret -is [Security.SecureString]) { $secret.Dispose() }
    }
}
