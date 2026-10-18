# One-time, as Administrator on BOP. Runs the Papers server from C:\PapersServer\App (D: is portable) and keeps
# a mirror in D:\PapersServer\App. Data stays in D:\PapersServer\Data. Restores the previous task on failure.
param([string]$User='BOP\TLPC')
$ErrorActionPreference='Stop'
$setup=$PSScriptRoot;$taskName='Papers Durable Replica'
$root='C:\PapersServer\App';$mirror='D:\PapersServer\App';$data='D:\PapersServer\Data'
$node='C:\Program Files\nodejs\node.exe'
$receipt=Join-Path $setup 'move-to-c-deployment.json'
$backupXml=Join-Path $setup ('task-before-move-to-c-'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'.xml')
$switched=$false
try{
 $cur=(Get-Content "$root\current.txt" -Raw).Trim()
 if(-not (Test-Path "$root\supervisor.mjs") -or -not (Test-Path "$root\$cur\main.mjs")){throw 'C:\PapersServer\App is not staged'}
 Export-ScheduledTask -TaskName $taskName | Set-Content -LiteralPath $backupXml -Encoding Unicode
 # Only this user, SYSTEM and Administrators may change the code this task runs.
 & icacls.exe 'C:\PapersServer' /inheritance:r /grant:r "${User}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' /C /Q | Out-Null
 if($LASTEXITCODE -ne 0){throw 'Setting folder permissions failed'}
 & icacls.exe $root /reset /T /C /Q | Out-Null   # everything below inherits the top folder's entries
 if($LASTEXITCODE -ne 0){throw 'Resetting folder permissions failed'}
 Stop-ScheduledTask -TaskName $taskName
 Start-Sleep -Seconds 3
 Remove-Item -LiteralPath (Join-Path $data 'portal-status.json') -ErrorAction SilentlyContinue
 $action=New-ScheduledTaskAction -Execute $node -Argument ('"'+$root+'\supervisor.mjs" "'+$root+'" "'+$data+'" "'+$mirror+'"') -WorkingDirectory $root

 $trigger=New-ScheduledTaskTrigger -AtStartup
 $principal=New-ScheduledTaskPrincipal -UserId $User -LogonType S4U -RunLevel Limited
 $settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
 Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
 $switched=$true
 Start-ScheduledTask -TaskName $taskName
 $ready=$false
 for($i=0;$i -lt 40;$i++){Start-Sleep 1;$s=Join-Path $data 'portal-status.json';if(Test-Path $s){$st=Get-Content $s -Raw|ConvertFrom-Json;if($st.ready){$ready=$true;break};throw ('Portal did not start: '+$st.error)}}
 if(-not $ready){$info=Get-ScheduledTaskInfo -TaskName $taskName;$t=Get-ScheduledTask -TaskName $taskName;throw ('Portal did not become ready; task state '+$t.State+', last result '+$info.LastTaskResult+', action '+$t.Actions[0].Arguments+', user '+$t.Principal.UserId+'/'+$t.Principal.LogonType)}
 @{ok=$true;at=[DateTime]::UtcNow.ToString('o');root=$root;mirror=$mirror;current=$cur;backupTask=$backupXml}|ConvertTo-Json|Set-Content -LiteralPath $receipt
}catch{
 $problem=$_.Exception.Message
 try{if($switched){Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue;Register-ScheduledTask -TaskName $taskName -Xml (Get-Content $backupXml -Raw) -Force | Out-Null;Start-ScheduledTask -TaskName $taskName}}catch{$problem+='; restore: '+$_.Exception.Message}
 @{ok=$false;at=[DateTime]::UtcNow.ToString('o');error=$problem;backupTask=$backupXml}|ConvertTo-Json|Set-Content -LiteralPath $receipt
 throw
}
