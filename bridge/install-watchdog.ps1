# 注册「ZCode Bridge 看门狗」计划任务：登录时启动 + 每 5 分钟补拉（当前用户权限，无需管理员）。
# 卸载：schtasks /Delete /TN "ZCode Bridge Watchdog" /F
$ErrorActionPreference = 'Stop'
$bridgeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
New-Item -ItemType Directory -Force -Path (Join-Path $bridgeRoot 'test\out') | Out-Null

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$bridgeRoot\watchdog.ps1`"" `
  -WorkingDirectory $bridgeRoot
$triggerLogon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$triggerRepeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

Register-ScheduledTask -TaskName 'ZCode Bridge Watchdog' `
  -Action $action -Trigger $triggerLogon, $triggerRepeat -Settings $settings -Force | Out-Null
Write-Output '已注册计划任务「ZCode Bridge Watchdog」（登录自启 + 每 5 分钟看门狗）。'
Write-Output '卸载：schtasks /Delete /TN "ZCode Bridge Watchdog" /F'
# 立即跑一次，把当前 bridge 拉起来
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $bridgeRoot 'watchdog.ps1')
