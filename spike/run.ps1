# Starts the spike behind a public Cloudflare tunnel (quick tunnel, no account).
# Usage: powershell -ExecutionPolicy Bypass -File run.ps1 [-Port 3000]
# WARNING: the server becomes reachable from the Internet while the script runs.
# Rooms are in memory and expire in 1 h, but anyone who knows the URL can create rooms.
# Ctrl+C stops the server and the tunnel.
param([int]$Port = 3000)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Test-Path node_modules)) { npm install }

$cf = Get-Command cloudflared -ErrorAction SilentlyContinue
if (-not $cf) {
  Write-Host "cloudflared not found. Install with:  winget install Cloudflare.cloudflared" -ForegroundColor Yellow
  Write-Host "Then reopen the terminal and run again. (Alternative: ngrok http $Port, then PUBLIC_URL=<url> npm start)"
  exit 1
}

$log = Join-Path $env:TEMP "agent-office-tunnel-$PID.log"
$tunnel = Start-Process -FilePath $cf.Source -ArgumentList "tunnel --url http://localhost:$Port --no-autoupdate" `
  -RedirectStandardError $log -RedirectStandardOutput "$log.out" -PassThru -WindowStyle Hidden
try {
  $url = $null
  foreach ($i in 1..40) {
    Start-Sleep -Milliseconds 750
    if (Test-Path $log) {
      $m = Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' | Select-Object -First 1
      if ($m) { $url = $m.Matches[0].Value; break }
    }
    if ($tunnel.HasExited) { throw "cloudflared exited: see $log" }
  }
  if (-not $url) { throw "Tunnel URL not found within 30 s: see $log" }

  Write-Host ""
  Write-Host "Tunnel:  $url" -ForegroundColor Green
  Write-Host "Admin page (open in the browser, create the room):  $url/"
  Write-Host "Then give each participant the roomId + inviteSecret; the join returns the snippet for their host."
  Write-Host "Remember: the snippets are UNTESTED. Fill in the table in README.md (manual test protocol)."
  Write-Host "Long-poll test: check that the tunnel does not cut room_inbox at 25 s (F3 in the README)."
  Write-Host ""

  $env:PUBLIC_URL = $url
  $env:PORT = "$Port"
  npm start
}
finally {
  if ($tunnel -and -not $tunnel.HasExited) { Stop-Process -Id $tunnel.Id -Force }
  Remove-Item $log, "$log.out" -ErrorAction SilentlyContinue
}
