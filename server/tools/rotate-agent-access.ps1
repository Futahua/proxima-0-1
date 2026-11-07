param([Parameter(Mandatory=$true)][string]$DataDirectory,[string]$ReaderSid=([Security.Principal.WindowsIdentity]::GetCurrent().User.Value))
$ErrorActionPreference='Stop'
$directory=(Resolve-Path -LiteralPath $DataDirectory).Path
$target=Join-Path $directory 'agent-access.json'
$temp=Join-Path $directory ('agent-access-'+[guid]::NewGuid()+'.tmp')
$prior=Join-Path $directory ('agent-access-'+[guid]::NewGuid()+'.retired')
$key=[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).TrimEnd('=').Replace('+','-').Replace('/','_')
[IO.File]::WriteAllText($temp,(@{version=1;enabled=$true;key=$key}|ConvertTo-Json -Compress))
$acl=Get-Acl -LiteralPath $temp
$acl.SetAccessRuleProtection($true,$false)
foreach($sid in @($ReaderSid,'S-1-5-18','S-1-5-32-544')|Select-Object -Unique){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','Allow'))}
Set-Acl -LiteralPath $temp -AclObject $acl
$hadPrior=Test-Path -LiteralPath $target
if($hadPrior){Move-Item -LiteralPath $target -Destination $prior}
try{Move-Item -LiteralPath $temp -Destination $target}catch{if($hadPrior){Move-Item -LiteralPath $prior -Destination $target};throw}
if($hadPrior){Remove-Item -LiteralPath $prior}
'Agent credential rotated locally; public sharing unchanged. Credential not printed.'
