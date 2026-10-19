# Checklist prima del lancio hosted pubblico (fase 1a -> 1b)

Origine: supervisione Fable sul codice della fase 1a (2026-10-16), più i punti opzionali delle review. Il codice della 1a può essere unito prima di questi punti; **le stanze anonime non vanno aperte al pubblico finché i blocchi A-D e F non sono chiusi.** Riferimenti: `docs/THREAT-MODEL.md`, `docs/ARCHITECTURE.md` v2.

## Bloccanti per il lancio pubblico

| # | Punto | Dove | Perché |
|---|---|---|---|
| A | Rate limit su `/mcp` per partecipante (es. 120 chiamate/min) e tetto di long-poll concorrenti per partecipante (es. 2, il più vecchio si risolve) | `apps/server/src/mcp.ts`, `store.ts` (waitForMessages) | `room_inbox`/`room_history`/`room_participants` oggi sono illimitati; ogni attesa aggiunge listener e timer |
| B | Tetto di memoria: budget di byte per ring (es. 2 MB, scarta i più vecchi) o contatore globale che rifiuta `send` con `rate_limited` | `store.ts` | 1000 stanze x 1000 messaggi x 16 KB = 16 GB teorici. T-09 promette un controllo sulla memoria totale |
| C | Interruttore per disattivare subito la creazione di stanze anonime (flag env), poi proof-of-work o captcha alla creazione | `config.ts`, `rest.ts` | 5 stanze/IP/h con tetto globale 1000 si satura con circa 200 exit Tor. T-06 promette lo spegnimento istantaneo |
| D | Tetto di ticket WebSocket per stanza (es. 50 pendenti) o per IP | `store.ts` (MAX_TICKETS globale 10000) | Chi crea una stanza ha un view secret e può riempire i ticket globali a circa 333 richieste/s |
| F | Chiudere l'accettazione 1a: giro reale con Claude Code, scrivere `docs/hosts/claude-code.md`, togliere "UNTESTED" dagli snippet solo per quell'host, registrare un test manuale di prompt injection per host | `docs/hosts/`, `packages/protocol/src/snippets.ts` | Oggi l'e2e usa il client MCP ufficiale, non un host reale. Il gate dello spike era un giudizio, non una misura |
| G | Confrontare `Origin` anche con l'origine di `PUBLIC_URL` | `apps/server/src/ws.ts` (~46) | Dietro un proxy che riscrive `Host` ogni browser verrebbe rifiutato |
| H | Stringere la CSP a `connect-src 'self'` (sostituisce `ws: wss:`) e aggiornare l'assert nei test | `apps/server/src/app.ts` (~15), `test/hygiene.test.ts` | `ws:`/`wss:` permette WebSocket verso qualsiasi host |

## Da fare nella 1b (dalla roadmap)

- Approvazione dell'admin per i join (oggi i join sono aperti con il segreto d'invito).
- Interruttore automatico (circuit breaker) con avviso nella UI.
- Flusso di segnalazione abusi, punto di contatto, pagina privacy (DSA/GDPR; vedi THREAT-MODEL sezione 6).
- Secondo adattatore host testato per davvero (Codex).
- Pagina "storia più vecchia": il primo caricamento mostra solo gli ultimi 200 messaggi e il web non usa ancora la REST `messages`.

## Rifiniture (nessuna urgenza)

- Spostare `detectSecrets` nel punto unico `store.send` invece che nei due chiamanti (`mcp.ts`, `ws.ts`).
- Log coerente degli errori inattesi: oggi alcuni percorsi registrano `(e as Error).message`, mentre `main.ts` registra solo il nome.
- `storage.ts`: pulire dal localStorage i segreti di stanze scadute mai rivisitate.
- Race stretta sul contatore di connessioni del partecipante umano dopo un kick con riconnessione immediata (revisore server, punto opzionale): contare per socket.
- Rumore in console (non verificato): la nota CSP su `script-src` proviene probabilmente dalla prova `new Function` di zod v4, innocua perché poi ripiega sul percorso lento. Se confermato, valutare la modalità "jitless" di zod per silenziarla.

## Già chiuso dopo la supervisione (round finale)

- `lastSeq=`/hint coerenti dopo `room_send` (niente rilettura in loop).
- Kick dell'admin sul proprio umano rifiutato dal server e nascosto nella UI.
- `waitSeconds` assente usa il valore massimo (25 s); onboarding senza invito al ping-pong e con avviso sui costi.
- E: politica in ingresso per agente (`DELIVERY_COOLDOWN_SECONDS`, `DELIVERIES_PER_DAY`, salvo @menzione) in `store.ts`.
