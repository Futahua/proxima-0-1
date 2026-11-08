# One-time, as Administrator on BOP. Moves the Papers server to D:\PapersServer\App and runs it as this
# user, so later updates need no administrator rights. Restores the previous task if anything fails.
param([string]$User='BOP\TLPC')
$ErrorActionPreference='Stop'
$setup=$PSScriptRoot
$taskName='Papers Durable Replica'
$old='C:\Program Files\PapersReplica\app-20261018'
$root='D:\PapersServer\App'
$data='D:\PapersServer\Data'
$node='C:\Program Files\nodejs\node.exe'
$receipt=Join-Path $setup 'user-updates-deployment.json'
$backupXml=Join-Path $setup ('task-before-user-updates-'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'.xml')
$switched=$false
try{
 if(-not (Test-Path (Join-Path $root 'supervisor.mjs'))){throw 'supervisor.mjs is not staged in D:\PapersServer\App'}
 Export-ScheduledTask -TaskName $taskName | Set-Content -LiteralPath $backupXml -Encoding Unicode
 if(-not (Test-Path (Join-Path $root 'app-20261018\main.mjs'))){& robocopy.exe $old (Join-Path $root 'app-20261018') /E /NFL /NDL /NJH /NJS /NP | Out-Null; if($LASTEXITCODE -ge 8){throw 'Copying the server code failed'}}
 Set-Content -LiteralPath (Join-Path $root 'current.txt') -Value 'app-20261018' -NoNewline
 & icacls.exe $root /grant "${User}:(OI)(CI)M" | Out-Null
 & icacls.exe $data /grant "${User}:(OI)(CI)M" /T /C /Q | Out-Null
 Stop-ScheduledTask -TaskName $taskName
 Start-Sleep -Seconds 3
 Remove-Item -LiteralPath (Join-Path $data 'portal-status.json') -ErrorAction SilentlyContinue
 $action=New-ScheduledTaskAction -Execute $node -Argument ('"'+(Join-Path $root 'supervisor.mjs')+'" "'+$root+'" "'+$data+'"') -WorkingDirectory $root
 $trigger=New-ScheduledTaskTrigger -AtStartup
 $principal=New-ScheduledTaskPrincipal -UserId $User -LogonType S4U -RunLevel Limited
 $settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
 Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
 $switched=$true
 Start-ScheduledTask -TaskName $taskName
 $ready=$false
 for($i=0;$i -lt 40;$i++){Start-Sleep -Seconds 1;$s=Join-Path $data 'portal-status.json';if(Test-Path $s){$st=Get-Content $s -Raw|ConvertFrom-Json;if($st.ready){$ready=$true;break};throw ('Portal did not start: '+$st.error)}}
 if(-not $ready){throw 'Portal did not become ready'}
 $owner=(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {$_.CommandLine -like '*app-20261018*main.mjs*'} | Select-Object -First 1 | Invoke-CimMethod -MethodName GetOwner)
 @{ok=$true;at=[DateTime]::UtcNow.ToString('o');runsAs=($owner.Domain+'\'+$owner.User);root=$root;backupTask=$backupXml}|ConvertTo-Json|Set-Content -LiteralPath $receipt
}catch{
 $problem=$_.Exception.Message
 try{if($switched -or (Test-Path $backupXml)){Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue;Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {$_.CommandLine -like '*supervisor.mjs*' -or $_.CommandLine -like '*PapersServer\App*main.mjs*'} | ForEach-Object {Stop-Process -Id $_.ProcessId -Force};Register-ScheduledTask -TaskName $taskName -Xml (Get-Content $backupXml -Raw) -Force | Out-Null;Start-ScheduledTask -TaskName $taskName}}catch{$problem+='; restore: '+$_.Exception.Message}
 @{ok=$false;at=[DateTime]::UtcNow.ToString('o');error=$problem;backupTask=$backupXml}|ConvertTo-Json|Set-Content -LiteralPath $receipt
 throw
}
