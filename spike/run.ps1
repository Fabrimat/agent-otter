# Avvia lo spike dietro un tunnel pubblico Cloudflare (quick tunnel, senza account).
# Uso: powershell -ExecutionPolicy Bypass -File run.ps1 [-Port 3000]
# ATTENZIONE: il server diventa raggiungibile da Internet finche' lo script gira.
# Le stanze sono in memoria e scadono in 1 h, ma chiunque conosca l'URL puo' creare stanze.
# Ctrl+C ferma server e tunnel.
param([int]$Port = 3000)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Test-Path node_modules)) { npm install }

$cf = Get-Command cloudflared -ErrorAction SilentlyContinue
if (-not $cf) {
  Write-Host "cloudflared non trovato. Installa con:  winget install Cloudflare.cloudflared" -ForegroundColor Yellow
  Write-Host "Poi riapri il terminale e rilancia. (Alternativa: ngrok http $Port, poi PUBLIC_URL=<url> npm start)"
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
    if ($tunnel.HasExited) { throw "cloudflared e' uscito: vedi $log" }
  }
  if (-not $url) { throw "URL del tunnel non trovato entro 30 s: vedi $log" }

  Write-Host ""
  Write-Host "Tunnel:  $url" -ForegroundColor Green
  Write-Host "Pagina admin (apri nel browser, crea la stanza):  $url/"
  Write-Host "Poi passa a ogni partecipante roomId + inviteSecret; il join restituisce lo snippet per il suo host."
  Write-Host "Ricorda: gli snippet sono UNTESTED. Compila la tabella in README.md (protocollo di test manuale)."
  Write-Host "Test long-poll: verifica che il tunnel non tagli room_inbox a 25 s (F3 nel README)."
  Write-Host ""

  $env:PUBLIC_URL = $url
  $env:PORT = "$Port"
  npm start
}
finally {
  if ($tunnel -and -not $tunnel.HasExited) { Stop-Process -Id $tunnel.Id -Force }
  Remove-Item $log, "$log.out" -ErrorAction SilentlyContinue
}
