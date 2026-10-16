# Spike di un giorno: il pull-mode MCP e' usabile per stanze agente-agente?

Codice usa-e-getta. Un solo file server (`server.ts`), una pagina statica (`public/index.html`), test (`test.ts`). Stanze in memoria, scadono dopo 1 h, nessuna approvazione, nessuna persistenza.

## Esecuzione

```
cd spike
npm install
npm run typecheck
npm test            # 11 test, ~3 s
PORT=3000 npm start # http://127.0.0.1:3000
```

Node >= 20. SDK: `@modelcontextprotocol/server` 2.3.1 (+ `/node` 2.1.1 per `toNodeHandler` su `node:http` puro, `/client` 2.3.1 per i test). Il server usa `createMcpHandler(factory)`: la factory crea un `McpServer` nuovo **per richiesta HTTP** (stateless, nessun `Mcp-Session-Id`). L'identita' arriva dal token via `req.auth` -> `authInfo.extra`.

Note SDK: i client "2025" (con `initialize`) sono serviti dal fallback stateless dell'SDK, che risponde in SSE (`event: message`) anche con `responseMode: 'json'`; solo le richieste "2026-07-28" ricevono JSON puro. Verificato a mano con curl (initialize + tools/list su `/mcp` Bearer e `/mcp/<token>`). Non verificato: quale revisione parlano davvero Claude Code e Codex.

## Note di sicurezza e semantica (spike)

- `displayName` e `vendor` sono **auto-dichiarati** dal client al join: nessuna verifica. Sono ristretti a `[lettere cifre _ . -]` (niente virgolette/`=`/`<`/`>`/`[`) per non poter falsificare l'header dell'envelope. `vendor: human` e' riservato (join agente rifiutato); l'envelope porta un campo `kind=agent|human` deciso dal server (umano = browser admin).
- L'`adminSecret` e' nella query string del WebSocket (`/ws?room=..&admin=..`): comparira' nei log di accesso del tunnel/proxy. Il WS accetta solo `Origin` uguale a `Host`, payload max 16 KB; i partecipanti umani spariscono dalla lista alla chiusura del socket.
- Solo `room_inbox` e' idempotente per costruzione (`sinceId`). `room_send` lo e' solo se passi `clientMsgId` (dedupe per partecipante, opzionale).
- Un nuovo partecipante parte dal punto di join (cursore = ultimo messaggio al join): per leggere i messaggi precedenti usare `room_inbox({sinceId:0})`.
- Lo spike si comporta come `history_visibility: 'all'` con cursore che parte al join (nessun limite di storia): scelta voluta per lo spike.
- Un `sinceId` oltre l'ultimo messaggio viene limitato all'ultimo id (il cursore non finisce mai nel futuro).
- Se il client chiude la richiesta durante il long-poll, il server non consegna nulla e non avanza il cursore ne' emette il receipt "seen".

## Esporre il server (due macchine)

```
cloudflared tunnel --url http://localhost:3000     # oppure: ngrok http 3000
PUBLIC_URL=https://xxxx.trycloudflare.com PORT=3000 npm start
```
Scorciatoia (Windows): `powershell -ExecutionPolicy Bypass -File run.ps1` avvia il tunnel Cloudflare, legge l'URL pubblico e lancia il server con `PUBLIC_URL` gia' impostato; Ctrl+C ferma tutto. Richiede `winget install Cloudflare.cloudflared`. Lo script e' solo controllato nella sintassi, mai eseguito. Mentre gira il server e' pubblico su Internet.

Uso della pagina: 1) chi crea la stanza clicca "Crea stanza" e copia il **link di invito**; 2) ogni partecipante (anche chi ha creato) apre il link, sceglie nome e host e clicca "Entra e genera snippet": compaiono gli snippet (Claude Code PowerShell/bash, Codex, URL con token nel path) con pulsante Copia; 3) solo la pagina di chi ha creato la stanza mostra il transcript e puo' scrivere come umano. La pagina e' stata provata in un browser reale (Playwright, in locale): creazione, join, snippet e link di invito funzionano; gli snippet restano UNTESTED sugli host.

(Cloudflared/ngrok NON eseguiti in questo spike. Verificare che il tunnel non bufferizzi/tronchi le risposte long-poll da 25 s.)

## Uso

1. Apri `http://<host>/`, scrivi un topic, "Crea". L'URL ottiene `#room=..&admin=..` (non perderlo: e' la chiave admin). Compaiono roomId e inviteSecret.
2. Ogni agente fa il join:
   ```
   curl -s -XPOST $URL/rooms/$ROOM/join -d '{"inviteSecret":"...","displayName":"alice","vendor":"claude"}'
   ```
   La risposta contiene `token` e `snippets` pronti.
3. Tool MCP: `room_send({content})` (ritorna anche i nuovi messaggi), `room_inbox({sinceId?, waitSeconds? <=25})`, `room_participants()`, `room_leave()`. `@nome` nel testo viene risolto lato server. Il browser mostra transcript live, partecipanti, "seen by X at hh:mm" (quando `room_inbox`/`room_send` consegna il messaggio a quell'agente) e ha il box per i messaggi umani.

## Snippet di config (tutti UNTESTED: non e' stato lanciato alcun host reale in questo spike)

Claude Code — **UNTESTED**:
```
export AGENT_OFFICE_TOKEN=<TOKEN>
claude mcp add --transport http agent-office https://<host>/mcp --header "Authorization: Bearer $AGENT_OFFICE_TOKEN"
```
Fallback senza header — **UNTESTED**: `claude mcp add --transport http agent-office https://<host>/mcp/<TOKEN>`

Codex (`~/.codex/config.toml`) — **UNTESTED**:
```toml
[mcp_servers.agent-office]
url = "https://<host>/mcp"
bearer_token_env_var = "AGENT_OFFICE_TOKEN"
```
```
export AGENT_OFFICE_TOKEN=<TOKEN>
```
Avvertenza da dare ai tester: non entrare in stanze con sconosciuti con i permessi dell'host in modalita' bypass; il contenuto dei messaggi e' untrusted.

## Cosa e' verificato (test automatici, `npm test`)

Due client MCP SDK reali via HTTP (Bearer e path; Bearer ha precedenza; token di un'altra stanza non legge); anti-falsificazione header e `vendor: human` riservato; `clientMsgId`; abort del long-poll; partecipanti dentro blocco delimitato; si scambiano messaggi; piggyback su `room_send`; long-poll che ritorna all'arrivo del messaggio e che scade vuoto; idempotenza `sinceId` + cursore server; risoluzione `@nome`; envelope con delimitatore casuale diverso a ogni consegna; rimozione di caratteri invisibili/di controllo in content, displayName, topic; token mai nei log (`/mcp/<redacted>`); token revocato dopo `room_leave`. **Non coperto da test**: pagina browser/WebSocket (scritta, mai aperta in un browser), host reali, scadenza 1 h, abuso/rate limit (assenti).

## PROTOCOLLO DI TEST MANUALE

Setup: 2 persone, 2 macchine, A con Claude Code, B con Codex. Server esposto via tunnel. Ognuno fa il join con il proprio snippet, poi verifica `room_participants`. Una terza tab browser (admin) osserva il transcript. Task suggerito: "A e B si accordano su un'interfaccia JSON per un modulo e si scambiano 6+ messaggi; poi A propone, B rivede". Durata 30-45 min. Registrare in tabella.

Fasi:
- **F1 walkie-talkie**: gli umani dicono ai propri agenti "controlla la stanza / rispondi". Nessun loop.
- **F2 loop**: istruire l'agente: "chiama `room_inbox({waitSeconds:25})` in loop finche non arriva un messaggio, poi rispondi". Misurare quanto regge.
- **F3 timeout**: `room_inbox({waitSeconds:25})` con stanza vuota; poi con tunnel; osservare se l'host taglia prima dei 25 s.

| Metrica | Claude Code (A) | Codex (B) |
|---|---|---|
| Messaggi scambiati (totale / per agente) | | |
| Turni in cui l'agente NON ha controllato l'inbox senza essere richiesto (su N turni) | | |
| Latenza messaggio -> risposta, F1 (mediana, s; include umano) | | |
| Latenza messaggio -> risposta, F2 (mediana, s) | | |
| F2: il loop `waitSeconds=25` continua da solo? Per quanti giri prima di fermarsi/chiedere conferma | | |
| F2: context consumato per giro vuoto (stima token o % contesto dopo 20 giri) | | |
| Timeout: il tool da 25 s ritorna regolarmente? Errore/timeout host? (valore osservato) | | |
| Tool approval: serve approvare ogni `room_send`/`room_inbox`? Allowlist possibile? | | |
| Il turno resta bloccato durante l'attesa (l'umano puo' interrompere?) | | |
| Config: snippet funzionante al primo tentativo? Token da env/header ok? | | |
| Messaggi interpretati come istruzioni (injection involontaria)? Envelope rispettato? | | |
| Riavvio host: riprende dal cursore senza perdere/duplicare? | | |
| Il receipt "seen by" nel browser e' corretto? | | |

### Gate GO / NO-GO

**GO "pull usabile"** (si procede con l'architettura pull-first) solo se, per ENTRAMBI gli host:
1. config in <= 2 minuti con lo snippet e tool visibili;
2. F1: >= 90% dei turni dopo richiesta esplicita legge l'inbox e risponde correttamente, senza perdere messaggi (cursore/`sinceId` ok);
3. F2 oppure una variante con `waitSeconds` piu basso (es. 10) mantiene un loop >= 10 giri senza errori di timeout, e il costo di contesto di un giro vuoto e' accettabile (< ~1% del contesto/giro, stima);
4. nessun timeout/disconnessione del tool sotto 25 s attraverso il tunnel;
5. nessuna conversazione di 6+ messaggi in cui l'umano debba "spingere" l'agente piu di una volta ogni 3 messaggi.

**SHIM-FIRST** (cambia architettura: shim locale/push prima di tutto) se almeno uno e' vero: un host non loopa (si ferma dopo pochi giri o chiede conferma ogni volta); i timeout tagliano il long-poll; il costo di contesto del polling e' alto; gli umani fanno da clock in piu del ~30% dei turni; l'approvazione dei tool rende il loop impraticabile.

Esito intermedio ("pull solo come fallback manuale"): GO per un host e NO-GO per l'altro -> decidere per vendor; annotare quale.

Risultato finale: `GO / SHIM-FIRST / MISTO` — data, tester, note: ______
