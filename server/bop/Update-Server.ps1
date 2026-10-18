# Update without administrator rights. App\staging holds changed files laid out like an app folder.
# New version = current + staging; switch; roll back automatically if it does not come up. Keeps the last 3 versions.
$ErrorActionPreference='Stop'
$root='C:\PapersServer\App';$data='D:\PapersServer\Data';$staging="$root\staging"
$cur=(Get-Content "$root\current.txt" -Raw).Trim();$next='app-'+(Get-Date -Format 'yyyyMMdd-HHmmss')
& robocopy.exe "$root\$cur" "$root\$next" /E /NFL /NDL /NJH /NJS /NP | Out-Null;if($LASTEXITCODE -ge 8){throw 'copy failed'}
& robocopy.exe $staging "$root\$next" /E /NFL /NDL /NJH /NJS /NP | Out-Null;if($LASTEXITCODE -ge 8){throw 'overlay failed'}
Remove-Item "$data\portal-status.json" -ErrorAction SilentlyContinue
Set-Content "$root\current.txt" $next -NoNewline;Set-Content "$root\restart.request" (Get-Date -Format o)
$ready=$false;for($i=0;$i -lt 30;$i++){Start-Sleep 1;if(Test-Path "$data\portal-status.json"){$s=Get-Content "$data\portal-status.json" -Raw|ConvertFrom-Json;$ready=[bool]$s.ready;break}}
if(-not $ready){Set-Content "$root\current.txt" $cur -NoNewline;Set-Content "$root\restart.request" (Get-Date -Format o);Remove-Item "$root\$next" -Recurse -Force;throw "not ready; rolled back to $cur"}
Remove-Item $staging -Recurse -Force
Get-ChildItem $root -Directory -Filter 'app-*' | Sort-Object Name -Descending | Select-Object -Skip 3 | Remove-Item -Recurse -Force
"switched $cur -> $next"
Get-Content "$root\server.log" -Tail 3
