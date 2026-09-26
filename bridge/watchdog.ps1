# ZCode Bridge 看门狗：检查 8787 端口，不在监听则拉起 bridge（隐藏窗口）。
# 由计划任务周期调用（见 install-watchdog.ps1）；手动运行亦等效。
$ErrorActionPreference = 'SilentlyContinue'
$bridgeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

$listening = netstat -ano | Select-String 'TCP\s+\S+:8787\s+\S+\s+LISTENING'
if ($listening) { exit 0 }

Start-Process -WindowStyle Hidden -FilePath node `
  -ArgumentList 'src/server.js' `
  -WorkingDirectory $bridgeRoot `
  -RedirectStandardOutput (Join-Path $bridgeRoot 'test\out\bridge-prod.log') `
  -RedirectStandardError (Join-Path $bridgeRoot 'test\out\bridge-prod.err.log')
Write-Output "bridge 已由看门狗拉起 $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
