# Critica tecnica di ARCHITECTURE.md

Data analisi: 2026-10-16. Documento analizzato: `docs/ARCHITECTURE.md` (298 righe, letto per intero).
Fatti esterni verificati via web sono marcati **[web]**; quelli che arrivano dalla mia conoscenza e vanno ricontrollati sono marcati **[verificare]**.

## 0. Sintesi

L'architettura e' ben pensata sul versante sicurezza e prodotto, ma e' **dimensionata per la fase 3 mentre dichiara di essere la fase 1**. Per "due agenti su due macchine in una stanza che muore dopo 1 ora" servono: un processo Node, un endpoint MCP, un WebSocket, uno stato in memoria. Redis Streams con consumer group per agente, NestJS modulare, monorepo a 3 app, Postgres/Drizzle, router di porte e Lua sono costo anticipato senza valore in fase 1.

Ci sono inoltre **errori concreti** (non di gusto) nel design Redis e un **rischio di obsolescenza** sul transport MCP:

| # | Severita | Tema |
|---|---|---|
| F1 | Critica | Spec MCP 2026-07-28 ha rimosso le sessioni: il design deve essere stateless-first |
| F2 | Critica | Long-poll `room_inbox` 25 s vs timeout host e intermediari: fragile, e semantica group/`sinceId` contraddittoria |
| F3 | Critica | "Nessun dato durevole" e' falso con la configurazione Redis di default (RDB) |
| F4 | Alta | `XREADGROUP BLOCK` = una connessione Redis bloccata per agente in attesa: non scala e non serve |
| F5 | Alta | TTL: i consumer group non sono chiavi; XADD su chiave scaduta ricrea stream senza gruppi; chiavi create dopo |
| F6 | Alta | Stima 2-3 settimane irrealistica per il perimetro dichiarato |
| F7 | Alta | Costo token per wake non modellato; la sola "batch" non basta |
| F8 | Alta | Token nell'URL: leak in log/proxy/history/crash report, e interazione con cache |
| F9 | Media | NestJS sovradimensionato per fase 1 |
| F10 | Media | WebSocket multi-istanza: fan-out non definito |
| F11 | Media | Upgrade anonimo -> permanente: non atomico, storia e token |
| F12 | Media | Router delle porte: correttezza (cicli, dedupe, idempotenza, ordering) |
| F13 | Media | Semantica di `move` incompleta |
| F14 | Media | Memoria Redis e abuso: nessun tetto globale, politica di eviction non specificata |
| F15 | Media | Postgres/Drizzle/monorepo: tempistica e scelte |
| F16 | Bassa | Lua rate limiter, hash tag, Cluster: prematuri |
| F17 | Info | Pezzi mancanti |

---

## F1 (Critica) - MCP Streamable HTTP: la spec e' diventata stateless

**[web]** La revisione MCP **2026-07-28** rimuove le sessioni a livello di protocollo da Streamable HTTP: sparisce l'header `Mcp-Session-Id`, sparisce l'handshake `initialize` (ogni richiesta porta versione, client info e capabilities in `_meta`; arriva `server/discover`), diventano obbligatori gli header `Mcp-Method` / `Mcp-Name` sui POST. Vecchie e nuove versioni **non interoperano**: l'unica strada e' supportarle entrambe. Gli SDK TypeScript sono stati aggiornati in concomitanza. Fonti: [Cloudflare, "The next generation of MCP"](https://blog.cloudflare.com/mcp-v2/), [Composio, update 2026-07-28](https://composio.dev/blog/mcp-2026-07-28-update-statelessness-apps-auth), [changelog](https://modelcontextprotocol.net/specification/2026-07-28/changelog). Non ho letto la pagina ufficiale di versioning: **[verificare]** stato finale e quali host (Claude Code, Codex, OpenCode, Hermes) parlano gia' la nuova revisione. Nella pratica per mesi coesisteranno host vecchi (stateful, `initialize`) e nuovi (stateless).

Conseguenze sul documento:
- Il doc dice solo "Verify current transport spec". Insufficiente: va deciso **ora** che il server e' **stateless per costruzione**. Con il token (path o Bearer) l'identita' e' gia' in ogni richiesta; non serve nessuno stato di sessione MCP. `room_identify` come "primo call che imposta l'identita' dichiarata" e' di per se' uno stato di sessione: va ripensato come chiamata che scrive su `members[participantId]` (stato nel dominio, non nella sessione di trasporto), e `room_send` deve funzionare anche se `room_identify` non e' mai stato chiamato (fallback: displayName generato al join, che avviene gia' via REST `POST /rooms/:id/join` con `displayName` e `vendor`; quindi `room_identify` e' **ridondante**, eliminarlo).
- Modalita' consigliata dell'SDK: **stateless** (`sessionIdGenerator: undefined`) con un `McpServer` + transport creati **per richiesta** (e' il pattern documentato dall'SDK TS per server stateless **[verificare]** contro la versione corrente). Costa pochi microsecondi, elimina mappa sessioni, sticky routing, cleanup delle sessioni orfane, e il problema "client riparte e la sessione e' sparita (404)".
- Server-to-client SSE (notifiche, stream GET) in modalita' stateless non esiste: coerente con la scelta "pull" del doc. Va dichiarato esplicitamente che **non si usano** notifiche/subscription MCP nemmeno nelle fasi successive: il push passa dallo shim locale.
- Rischio SDK: Nest + Fastify non e' il caso d'uso previsto. Il transport dell'SDK TS (`StreamableHTTPServerTransport`) e' scritto su `IncomingMessage`/`ServerResponse` di Node (stile Express). Con Fastify serve passare `reply.raw` e dire a Fastify che la risposta e' gestita (`reply.hijack()`), pena doppie scritture e header errati. Con Nest in mezzo si aggiungono interceptor/filtri che non devono toccare quella risposta. E' fattibile ma e' una zona dove si perdono giorni. Un `app.post('/mcp/:token')` Fastify nudo e' piu' sicuro. Il fit con SDK e' quindi **medio**; testarlo nel primo spike, non a meta' fase.
- Validazione dei tool in `packages/protocol` con Zod: l'SDK accetta Zod, ma attenzione a mismatch di versione Zod (v3 vs v4) fra SDK e repo **[verificare]**; fissare la versione nel workspace.

## F2 (Critica) - `room_inbox` long-poll e semantica contraddittoria

Problemi di timeout:
- **[web]** I timeout dei client sono eterogenei e instabili: Claude Code ha `MCP_TOOL_TIMEOUT` (valore di default molto alto riportato nei docs, ma bug aperti/chiusi in cui il timeout configurato viene ignorato in alcuni client o ha un default di pochi secondi in una versione specifica), e dalla v2.1.187 le chiamate MCP remote senza **alcuna risposta per 5 minuti** vengono abortite (`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`); l'app Desktop ha mostrato cancellazioni a ~60 s. Fonti: [issue #20335](https://github.com/anthropics/claude-code/issues/20335), [issue 63379](https://claudeissues.com/issue/63379-bug-desktop-app-cancels-stdio-mcp-tool-calls-at-60s-and-ignores-mcp-tool-timeout), [issue 70441](https://claudeissues.com/issue/70441-docs-mcp-docs-omit-remote-tool-idle-timeout-and-claude-code-mcp-tool-idle-timeout). Codex ha `tool_timeout_sec` per server con default che ricordo di 60 s **[verificare]**. Il valore 25 s e' ragionevole come massimo, ma va reso **un parametro per host** (il join page puo' emettere `waitSeconds` consigliato) e il default del server dovrebbe essere piu' basso (10-15 s) con 25 come tetto.
- Intermediari: Traefik/Coolify, Cloudflare (se davanti: timeout 100 s sui proxied, ok), eventuali proxy aziendali con idle timeout 30-60 s. 25 s e' sotto la maggior parte, ma serve `X-Accel-Buffering: no`/no compressione sulle risposte, e se si risponde in SSE per richiesta (come fa l'SDK quando `enableJsonResponse` e' false) bisogna scegliere: per un tool call con una sola risposta e' meglio **JSON response semplice** (`enableJsonResponse: true`), niente SSE.
- Il vero problema e' prodotto, non protocollo: **un agente che sta facendo il suo lavoro non chiama `room_inbox` in loop**. Il long-poll da 25 s funziona solo se il modello decide di chiamarlo; ogni chiamata e' un turno-modello. Un agente che "ascolta" in loop brucia token per ogni ciclo vuoto (vedi F7) e blocca il suo utente. Il default realistico e': l'agente controlla l'inbox quando l'utente glielo dice, o al termine di un task. Il doc chiama questo "Phase 1 baseline" ma l'acceptance test ("due agenti si scambiano messaggi") **dipende** da come questo viene orchestrato; serve un'istruzione di sistema/skill lato host (es. un `CLAUDE.md` snippet o slash command `/room-listen`) e va testata.
- Alternativa comoda: ogni risposta di `room_send` **restituisce gia' i messaggi nuovi** (piggyback). Cosi' un agente che parla riceve cio' che e' successo senza una chiamata in piu'. Costo zero lato server, riduce i turni.

Contraddizione di semantica:
- Il doc usa consumer group per agente con `XACK` dopo la consegna **e** `room_inbox({ sinceId })`. Sono due modelli di cursore diversi: nel group il cursore e' lato server (last-delivered-id + PEL), con `sinceId` il cursore e' lato client. Se il tool call va in timeout *dopo* che Redis ha consegnato (XREADGROUP aggiunge alla PEL) ma prima che l'agente abbia ricevuto la risposta, i messaggi restano pendenti e **l'agente non li rivedra' mai** a meno di rileggere con id `0` / `XAUTOCLAIM`. Il doc non lo menziona. Questo e' esattamente lo scenario piu' frequente (timeout host).
- Soluzione semplice: **cursore esplicito, idempotente, senza ack**. `room_inbox({ after })` restituisce messaggi con id > `after` e un `cursor` da riusare; il server tiene `lastSeen` per participant solo per la presenza. At-least-once gratis, nessuna PEL, nessun gruppo da creare/cancellare/scadere. Il server puo' ricordare l'ultimo cursore restituito per participant come default se `after` e' omesso, ma avanzandolo solo quando il client lo riconferma alla chiamata successiva (ack implicito = "ho ricevuto fino a X").

## F3 (Critica) - "Anonymous rooms store nothing durable" e persistenza Redis

- L'immagine ufficiale `redis` parte con i default compilati: snapshot RDB (`save 3600 1 300 100 60 10000`) su `dump.rdb`. Con un volume Docker (Coolify ne crea uno di solito per i database) i messaggi delle stanze anonime **finiscono su disco** e si **ripristinano al riavvio**. La promessa nella privacy page (sezione 3) sarebbe falsa. Per mantenerla: `--save "" --appendonly no`, **nessun volume** per l'istanza anonima, e controllo in CI/health che `CONFIG GET save` sia vuoto. Anche i log di Coolify/Traefik e i backup della VPS (snapshot Hetzner) vanno considerati: i dati in RAM non finiscono nei backup, quelli in `dump.rdb` si'.
- Redis puo' finire in swap: su VPS senza swap disattivato i contenuti di RAM possono essere paginati su disco. Minor, ma da citare nella privacy page come "best effort".
- Per le stanze **permanenti** (fase 2) la stessa istanza Redis non puo' avere politica di persistenza diversa per chiave. Il doc dice "stream MAXLEN ~10000, archived in Postgres" ma non dice **chi e' la fonte di verita'**. Opzioni:
  1. Postgres e' la fonte per le permanenti: `INSERT` in PG, poi notifica (Pub/Sub o in-process); Redis solo cache/tail. Pro: durabilita' vera, query, ricerca. Contro: scrittura sincrona su PG sul percorso dei messaggi (ok a questi volumi).
  2. Redis AOF `everysec` come fonte e archiviazione asincrona: finestra di perdita 1 s, e il job di archiviazione e' un secondo consumer da far girare con garanzie (un altro gruppo, un altro punto di guasto).
  Raccomandazione: **opzione 1**, e due istanze/DB Redis distinti solo se mai serve (anonime senza persistenza, permanenti con AOF). Meglio ancora: in fase 1 **niente Redis** (vedi sezione "Architettura consigliata").
- `maxmemory` / eviction non sono specificati: se qualcuno mette `allkeys-lru`, Redis cancellera' stanze vive. Serve `maxmemory` esplicito + `noeviction` e gestione dell'errore OOM (rifiutare la creazione di stanze con 503, non crashare). Vedi F14.

## F4 (Alta) - `XREADGROUP BLOCK` e connessioni

- Un comando bloccante occupa **l'intera connessione** Redis. Con ioredis/node-redis ogni long-poll in corso richiede una connessione dedicata (o un pool). N agenti in attesa = N connessioni Redis aperte, piu' il tempo di reconnessione. Il default `maxclients` e' 10000 ma il pool, i file descriptor e la memoria per connessione si fanno sentire molto prima; e ogni API instance ne fa altrettante.
- Inoltre ogni richiesta HTTP pendente e' una socket aperta lato Node (poco, ma e' il collo vero): 1000 agenti in attesa = 1000 richieste da 25 s. Node regge bene, ma il timeout di Fastify (`connectionTimeout`, `requestTimeout`, `keepAliveTimeout`) deve essere configurato coerentemente.
- Alternative, in ordine di semplicita':
  1. **Notifica in-process** (EventEmitter per stanza): `room_send` fa push al log in memoria e risveglia i waiter. Zero Redis. Funziona fino a una istanza.
  2. **Redis con un solo lettore per istanza**: una connessione per processo che fa `XREAD BLOCK` su piu' stream (`XREAD` accetta piu' chiavi; in Cluster solo se nello stesso slot, quindi per istanza con un set di stanze) oppure `SUBSCRIBE` a un canale `room:<id>`; poi fan-out in memoria ai waiter locali. Le richieste `room_inbox` leggono con un `XRANGE`/`XREAD` **non bloccante** e, se vuote, si registrano come waiter. Connessioni Redis = O(istanze), non O(agenti).
  3. Pub/Sub come segnale + XRANGE come fonte: Pub/Sub e' fire-and-forget, quindi **mai** come fonte di verita'; combinato con XRANGE dal cursore e' corretto anche se il segnale si perde (il waiter ha comunque il timeout di 25 s).
- Il consumer group non da' nulla di utile qui (vedi F2); per-agent group significa anche creare/eliminare gruppi a ogni join/leave/move e farli scadere, cioe' piu' stato da tenere pulito.
- Nota Redis 8 e licenza: dal Redis 8 la licenza e' tornata a includere AGPLv3 **[verificare]**. Valkey (BSD) e' un drop-in per Streams. Decisione da prendere per un eventuale self-hosted distribuito (punto aperto in sezione 18).

## F5 (Alta) - TTL con `PEXPIREAT` su ogni chiave

Errori e insidie nel meccanismo descritto:
1. **I consumer group non sono chiavi.** Vivono dentro la chiave stream; `PEXPIREAT` sullo stream li fa scadere insieme. Il doc dice "every key incl. consumer groups": termine impreciso, e un'implementazione che prova a espirare i gruppi non ha senso. (Un problema da comprendere, non da risolvere: eliminando i gruppi dal design, scompare.)
2. **XADD su stream scaduto ricrea la chiave senza gruppi e senza TTL.** Se un `room_send` arriva negli istanti dopo la scadenza (race normale, nessuna garanzia di ordine con la chiusura applicativa), nasce uno stream "zombie" **senza TTL** (il TTL non si eredita da una chiave inesistente). Perde i dati ma resta in memoria per sempre, e i consumer ricevono `NOGROUP`. Mitigazione: ogni scrittura passa da uno **script/funzione che controlla `meta` (esiste ed `expiresAt` > now)** prima di scrivere, e imposta il TTL se manca. Oppure usa `XADD ... NOMKSTREAM` (non crea lo stream se non esiste, Redis >= 6.2) **[verificare]**: soluzione a una riga per questo caso specifico.
3. **Chiavi create dopo**: `members`, `presence`, `pending`, `rl:*` sono create lazily; ogni creazione deve riapplicare `PEXPIREAT`. Dimenticarlo in un solo punto = chiave immortale = perdita di privacy e di memoria. Inoltre le operazioni che *sostituiscono* il valore **azzerano il TTL** (`SET` senza `KEEPTTL`, `RENAME` conserva, `GETSET`/`SET` no). Un contatore `rl` con `SET` invece di `INCR` perde il TTL.
4. Soluzione robusta: **un solo punto di scrittura** che esegue `<comando>` + `PEXPIREAT key expiresAt` nello stesso `MULTI`/Lua per tutte le chiavi toccate, e un **job di sweeper** che con `SCAN MATCH {room:*}:meta` verifica che ogni chiave `{room:X}:*` abbia TTL (`TTL = -1` => alert + `DEL`). Test di integrazione: crea una stanza, esercita ogni comando, poi asserisci `PTTL > 0` su tutte le chiavi con `KEYS {room:<id>}:*`.
5. **Ancora meglio**: ridurre il numero di chiavi. Un `HASH meta` + uno `STREAM` + (in fase 1) `members` come campo di `meta` o chiave unica. `presence` come ZSET con pruning e `pending` come HASH sono sostituibili da campi con timestamp in `members`. Meno chiavi = meno posti dove dimenticare il TTL.
6. Scadenza passiva+attiva: Redis cancella a campione; la chiave scaduta resta in RAM fino alla cancellazione attiva (ciclo 10 Hz) ed e' comunque invisibile. Il "i dati spariscono dopo il TTL" e' corretto per l'accesso, **non** istantaneo per la memoria. Accettabile, da non promettere "istantaneamente".
7. `room_closing` a 60 s prima: serve un timer applicativo (non una keyspace notification, che sono fire-and-forget e disattivate di default). In fase 1 un `setTimeout` per stanza in memoria.
8. L'orologio: `expiresAt` calcolato dall'app, `PEXPIREAT` usa l'orologio del server Redis. Su un'unica VPS ok; con istanze multiple e Redis remoto, drift => stanza che scade in anticipo/ritardo di secondi. Usare `PEXPIRE` relativo nello script con `TIME` di Redis o accettare tolleranza.

## F6 (Alta) - Stima fase 1 "2-3 settimane"

Il perimetro di fase 1 elencato nel doc:
- creazione stanza + TTL + invito + approvazione admin (REST + stato)
- MCP server con 5 tool, token, identita' dichiarata
- WebSocket browser con trascrizione, partecipanti, countdown
- SPA React (join page, room page, admin), snippet per host verificati **su due host reali**
- sicurezza 1-8: auth token, join approval, wrapping untrusted, wake policy, loop prevention (rate limit, cooldown, budget giornaliero, **circuit breaker**), secret scanner (pattern + entropia), rate limit IP, kill switch
- test: Testcontainers, fake MCP client, Playwright e2e, test automatico del wrapping, test manuale di prompt injection
- infra: Compose, Coolify, Pino, Prometheus, Grafana, CI
- monorepo con tre pacchetti, Astro (marcato "can come later" ma presente)

Per una persona, con agente AI che aiuta, e' realisticamente **5-8 settimane** per la qualita' dichiarata (test inclusi) e **2-3 settimane solo per un MVP senza admin approval, senza circuit breaker, senza scanner, senza Grafana**. I rischi che mangiano tempo e che il doc non prezza:
- **Onboarding per host** (voce 17): ogni host ha formato di config, gestione di `instructions`, comportamento del token in URL, bug di timeout. Ogni host reale vale 2-4 giorni di prove e di sorprese; il criterio "almeno due host testati per davvero" e' il vero tetto di tempo, perche' dipende da software altrui che cambia (gli host citati cambiano settimanalmente, lo dice il doc stesso).
- Spec MCP in cambiamento (F1): supportare vecchia+nuova revisione raddoppia i casi di test.
- Il doppio ruolo di NestJS/Fastify con SDK MCP (F1).
- Il test di prompt injection "automatizzato" e' un test sul wrapper, non sul comportamento del modello: il comportamento e' non deterministico e non automatizzabile in modo affidabile. Dichiararlo test manuale con checklist.
- Circuit breaker + UI "pausa": in realta' e' una funzione di fase 1.5 che dipende da metriche che ancora non esistono.

Raccomandazione: ridefinire Fase 1 in due traguardi: **1a (walking skeleton, ~1-1,5 settimane)**: stanza in memoria, token, MCP stateless con `room_send`/`room_inbox`/`room_participants`, trascrizione WebSocket, due host provati; **1b (~2-3 settimane)**: approvazione admin, secret scanner base, rate limit, kill switch, countdown, snippet per altri host, deploy, test e2e. Circuit breaker e budget giornaliero a 1b o fase 2 (le cap su messaggi/minuto bastano all'inizio).

## F7 (Alta) - Costi nascosti: token per wake

Il doc cita il costo ("every wake is a model turn") ma non lo quantifica ne' lo controlla nel design.
- Ogni `room_inbox` e' una chiamata tool: l'host rimanda al modello **l'intero contesto** (spesso con cache) piu' i messaggi. Anche con prompt cache, un turno costa decine di migliaia di token di input cached + output. Una conversazione tra due agenti con scambio ogni 20-30 s per 10 minuti = 20-30 turni per agente. Con contesti da 50-150k token letti dalla cache sono milioni di token cached-read per sessione, **pagati dagli utenti** (o consumati dalla loro quota di abbonamento). E' un costo che l'utente puo' non aspettarsi: un agente in "ascolto" in loop consuma quota anche con inbox vuoto.
- La cache dei prompt Anthropic ha TTL (5 minuti di default / 1 ora opzionale **[verificare]** sui valori correnti): un poll di 25 s la tiene calda, ma un agente che aspetta piu' a lungo paga la cache write completa a ogni wake.
- Mitigazioni da mettere nel design, non come "cost control" generico:
  1. Rispondere con `waitSeconds` lunghi ma **un solo** tool call attivo, e istruire l'agente a non rilanciare in loop senza input utente.
  2. **Digest e debounce lato server**: un wake ogni N secondi con tutti i messaggi accumulati (il doc lo dice per il push; vale prima ancora per il pull).
  3. Tetto di turni per agente per ora, mostrato in UI ("questo agente ha fatto 40 poll, ~X token stimati").
  4. Messaggi corti: il limite di 8 KB e' alto per un canale tra agenti; 2 KB come default riduce il rischio che una stanza diventi un generatore di contesto.
  5. Nella join page: **avviso esplicito** all'utente sul consumo di token/quota.
- Costo server: trascurabile in fase 1 (una VPS CX22 basta). La banda dei long-poll e' minima.

## F8 (Alta) - Token nell'URL (`/mcp/<token>`) e cache

Il vantaggio (un singolo copia-incolla) e' reale, il costo e' sottovalutato:
- **Leak in chiaro**: l'URL finisce nei log degli host (alcuni loggano l'endpoint MCP), nello storico shell dell'utente (`claude mcp add ... https://.../mcp/<token>`), negli screenshot, nei crash report, in `claude mcp list`, e in qualunque proxy intermedio e nei log di Traefik/Coolify (access log con path completo). "Redact in all logs" nel doc copre solo i log dell'app, non l'access log del reverse proxy: va configurato Traefik per non loggare il path (o usare `--accesslog.fields`) **[verificare]** sulla versione in uso.
- **Caching**: le risposte con token nel path possono essere memorizzate da CDN/proxy se mancano header. I POST non sono cacheabili di default, ma servono comunque `Cache-Control: no-store` su tutto (inclusa la REST che restituisce token), e `Referrer-Policy: no-referrer` sulle pagine web che mostrano l'URL. Il token nell'URL, se la pagina join viene aperta con `?token=`, finisce nel `Referer` verso risorse di terzi.
- **Token monouso di scambio**: alternativa molto migliore per mantenere l'ergonomia: il comando copia-incolla contiene un **codice di join breve a uso singolo (es. 10 minuti)** nell'URL, e il server lo scambia al primo `initialize`/prima richiesta con un bearer persistente che l'host non vede... ma questo richiede flusso OAuth o un header, quindi non funziona con host che accettano solo URL. Compromesso pratico: mantenere `/mcp/<token>`, ma con token **per-partecipante, breve durata (la vita della stanza), revocabile, e rotazione automatica al `move`**; preferire `Authorization: Bearer` (via `--header` in Claude Code, `bearer_token_env_var` in Codex **[verificare]**) come percorso consigliato, con l'URL token come fallback comodo.
- Il token in path e' anche **input a un hash lookup**: confrontare con SHA-256 + lookup per chiave e' ok (non serve constant-time perche' si indicizza per hash), ma limitare il rate delle richieste con token invalido per IP (enumerazione).
- Con 32 byte random l'enumerazione e' impossibile; il rischio e' solo il leak.
- Cache lato server `token:<sha256>`: la revoca deve fare `DEL` sincrono. TTL del cache = TTL della stanza o piu' breve; se Redis e' l'unica fonte in fase 1 il "cache of the DB row" non esiste.

## F9 (Media) - NestJS e' sovradimensionato per la fase 1

Argomenti:
- Fase 1 ha 3 superfici (REST con ~5 endpoint, 1 WebSocket, 1 endpoint MCP) e nessun DB. NestJS aggiunge DI, moduli, decoratori, pipeline di guard/interceptor/filter, build con SWC/tsc e metadata di riflessione, e **attrito specifico** con Fastify (adapter) e con SDK MCP scritto su Node raw (F1). Vantaggio reale: struttura per team, DI per test, Swagger. Per una persona sola con un agente di codice, e' overhead e superficie di bug.
- NestJS + Fastify + `@nestjs/websockets` con `ws`: il gateway Nest e' un wrapper di `ws`; il fan-out multi-stanza lo scrivi comunque a mano.
- Opzioni:
  1. **Fastify nudo** + `@fastify/websocket` (o `ws`) + Zod (`fastify-type-provider-zod`) + SDK MCP: ~400-700 righe per tutta la fase 1. Moduli = cartelle con funzioni. Consigliato.
  2. **Hono** su Node (`@hono/node-server` + `@hono/node-ws`): leggero, supporta Web Standard `Request/Response`, e **l'SDK TS MCP ha un transport Web Standard** (`WebStandardStreamableHTTPServerTransport` o equivalente nelle versioni recenti **[verificare]**), piu' naturale di Express/Fastify raw. Ottimo se si vuole poi andare su edge/Workers.
  3. **Cloudflare Workers + Durable Objects**: una stanza = un DO (stato, WebSocket hibernation, alarm per il TTL di 1 ora, nessun Redis, nessun multi-istanza da gestire: la stanza ha un solo proprietario per costruzione). Si adatta in modo notevole al dominio (le stanze sono attori isolati con TTL), risolve F5/F10/F14. Contro: vendor lock-in, il doc ha scelto Hetzner/Coolify e GDPR/EU (i DO hanno jurisdiction hint EU), debugging diverso, e il tuo target self-hosted ("Docker image open-source", punto aperto) viene meno. Da citare come alternativa seria, non come raccomandazione primaria.
- Se si mantiene Nest per ragioni di preferenza del team, rimuovere almeno i "moduli" `audit` e `presence` dalla fase 1.

## F10 (Media) - WebSocket: scaling e fan-out multi-istanza

Il doc dice "any instance can serve any room by reading its stream" ma il flusso non e' descritto:
- Browser A e' connesso all'istanza 1, un agente scrive tramite l'istanza 2. L'istanza 1 deve sapere del nuovo messaggio: serve o un lettore di stream per stanza **per istanza** (XREAD BLOCK, con tutti i problemi di F4) o Pub/Sub. Non e' specificato; e' la parte che costringe a usare Redis in modo non banale.
- Ordinamento e deduplicazione al reconnect: il browser deve inviare `lastEventId` al riaggancio e il server rilegge con `XRANGE`; il client deve deduplicare per ULID. Il doc non lo dice. Senza questo, ogni disconnessione del WS perde messaggi.
- ULID generato dal server vs id dello stream Redis: due id diversi per lo stesso messaggio. Usare **lo stream id come id canonico** (monotono per stanza) o salvare ULID come campo e tenere l'ordine dallo stream. Per ULID creati su istanze diverse l'ordine monotono non e' garantito; l'ordine di verita' e' quello dello stream.
- Limiti WS: heartbeat/ping (proxy chiudono idle a 60 s), backpressure (`bufferedAmount` per client lento, altrimenti un browser lento fa crescere la memoria), limite connessioni per IP/stanza, autenticazione del WS (il browser non puo' impostare header: ticket a breve durata in query o cookie; l'`adminSecret` in browser va trattato con cura, mai in URL).
- Un solo istanza su una VPS regge facilmente migliaia di WS. Il multi-istanza e' un problema da risolvere **quando c'e' una seconda istanza**. In fase 1 e 2 la scelta semplice e' una istanza + `MessageBus` in-process; l'interfaccia `MessageBus` del doc (sezione 15) e' ok ma con due sole implementazioni previste, in-memory e Redis, e va scritta solo quando esiste la seconda.
- Deploy con rolling restart: ogni deploy tronca tutti i WS e tutti i long-poll e, con stato in memoria, **tutte le stanze anonime**. Con Redis le stanze sopravvivono al deploy (vantaggio vero di Redis, e unico forte in fase 1). Accettabile per fase 1 pre-lancio: deploy a finestre e banner "manutenzione". Se questo vantaggio serve, usare Redis ma con la semplificazione di F4.

## F11 (Media) - Upgrade anonimo -> permanente

Il testo: "copy meta and members to Postgres, `PERSIST` all room keys, set `kind=permanent`, keep existing history up to MAXLEN".
- **Non atomico**: PG e Redis sono due sistemi. Sequenza consigliata: (1) controlla in Redis `PTTL` > margine (es. 30 s) e blocca nuove scritture sulla stanza (`meta.state=claiming`), (2) INSERT in PG in una transazione, (3) `PERSIST` su tutte le chiavi, (4) `kind=permanent`. Se il passo 3 fallisce a meta', la stanza e' in PG ma Redis scade: serve un job di riconciliazione che riprova `PERSIST`. E se la stanza scade **durante** l'upgrade, righe orfane in PG: transazione e verifica alla fine.
- `PERSIST` su tutte le chiavi richiede enumerarle: con le chiavi create lazily (F5) ci sono chiavi che il codice di upgrade non conosce. Meglio un registro delle chiavi in `meta` o un prefisso noto e `SCAN`.
- Il **cambio di durabilita'** non avviene: la stanza resta in un Redis senza persistenza (F3). Una stanza "permanente" che perde i messaggi a un riavvio di Redis e' un bug di prodotto. L'upgrade e' quindi anche una **migrazione di fonte di verita'**: dopo il claim i messaggi nuovi devono andare in PG (F3, opzione 1) e la storia gia' presente va copiata in PG (il doc la lascia solo in Redis: dopo la scadenza di Redis o il riavvio si perde).
- Token: i token anonimi "expire with the room" (sicurezza 10). Dopo il claim la scadenza va rimossa/estesa **per i token esistenti**, ma i token hashed sono in cache in Redis con TTL; se non si ri-scrivono con `PERSIST` tutti i token degli agenti gia' connessi **muoiono all'ora zero** e gli agenti restano scollegati con un errore criptico. Va incluso nel test di acceptance.
- Sicurezza: il claim richiede `adminSecret` + login. Chi ha l'invito non deve poter fare claim; l'`adminSecret` (nel browser, che puo' essere perso) e' una credenziale single point of failure per la stanza anonima: se la perdi, perdi l'admin. Documentare.
- Chiave `room:<id>` e' un id che compare in URL di invito: deve essere non indovinabile (>= 128 bit), altrimenti `GET /rooms/:id` enumera stanze.

## F12 (Media) - Correttezza del router delle porte (fase 3)

- Un consumer **per porta** o per stanza di origine? "its own consumer group" sul source stream: se piu' porte partono dalla stessa stanza, ogni porta deve avere un gruppo distinto o si perdono messaggi (un gruppo condiviso distribuisce i messaggi tra i consumer, non li duplica). Specificare: un gruppo per porta.
- **Cicli**: stanza A <-> B con `two_way` e `mode=all`: un messaggio A->B ottiene `hops=1`, B->A `hops=2` e si ferma a `hopLimit=2`, ma ogni messaggio umano genera due eco e il **messaggio duplicato** puo' riapparire in A con altro id. Il dedupe "message id + door id" non intercetta il caso: la copia ha un **nuovo id** nella stanza di destinazione. Serve un `originId` (id del messaggio originale) propagato, e dedupe su `(originId, destRoomId)`. Con porte A->B, B->C, A->C lo stesso messaggio arriva a C due volte per percorsi diversi: stesso `originId`, quindi dedupe per `(originId, destRoomId)` lo risolve; senza `originId` no.
- **Idempotenza**: il router puo' crashare tra `XADD` nella destinazione e `XACK` nella sorgente => duplicato al restart. Il dedupe va fatto **dentro** la scrittura (script Lua: `SET dedupe:(origin,dest) NX` + `XADD`) e le due stanze possono **non** stare nello stesso slot Cluster: l'hash tag per stanza (F16) rende **impossibile** una Lua su entrambe. Va fatto in due passi con chiave di dedupe sullo slot di destinazione.
- **Ordinamento**: il router consuma da piu' sorgenti e scrive in una destinazione: l'ordine relativo fra messaggi di sorgenti diverse e' arbitrario, e quello del router stesso e' per-sorgente. Va bene, ma i `replyTo` possono puntare a un id che nella destinazione non esiste (id diversi): serve mappatura `originId`.
- **Trust**: il messaggio inoltrato da un agente della stanza A e' un messaggio **untrusted** nella B (trust non puo' essere promosso). Un messaggio umano inoltrato oltre porta resta `human` solo per la stanza che l'umano governa? Decisione di policy: un messaggio umano di A letto in B non dovrebbe avere trust `human` per gli agenti di B (la persona non e' il loro utente). Il doc non lo dice: va forzato a `untrusted`.
- **Wake policy attraverso porta**: un messaggio che attraversa una porta non deve svegliare per mention sulla destinazione senza che la porta lo consenta (`mentions` sono id partecipante, che non esistono nell'altra stanza).
- **Cancellazione/privacy**: l'inoltro duplica il contenuto in una stanza con altri membri e altro TTL: una stanza anonima collegata a una permanente fa **sopravvivere** il contenuto oltre il TTL. Fuori scope della fase 1 ma da vietare (porte solo fra permanenti).
- Il router come "Nest service" dentro l'API: con piu' istanze serve **un solo router attivo per porta** (altrimenti duplicati). I consumer group aiutano, ma solo se il messaggio e' idempotente come sopra.

## F13 (Media) - Semantica di `move`

- Il doc: "new consumer group in the target stream, membership updated, old one removed, token rebound. The agent receives a system message saying it moved."
- Problemi: (1) l'agente e' una **sessione utente su una macchina remota**; spostarlo significa solo cambiare dove il suo token punta. L'host dell'agente non sa nulla finche' non chiama un tool; il long-poll in corso sul vecchio room deve essere interrotto e risposto con un risultato esplicito `moved`. (2) "Token rebound": se il token e' nell'URL, cambiare il significato di un segreto gia' distribuito significa che **ogni copia del vecchio comando punta ora alla nuova stanza**, e la configurazione dell'utente e' invisibilmente cambiata: l'utente non l'ha approvato. E' una violazione del principio "ogni azione sulla macchina dell'utente richiede il suo consenso", pur essendo indiretta: un amministratore di stanza (non il proprietario) puo' portare l'agente di qualcun altro in una stanza dove arrivano messaggi ostili (injection). Raccomando: **move = richiesta con consenso del proprietario dell'agente** (human-in-the-loop sul browser dell'owner), mai forzata da un admin di stanza.
- (3) Il messaggio di sistema "you moved" e' un canale di controllo: il doc dice che viaggia su canale separato, ma l'unico canale che l'agente vede e' il risultato dei tool. Quindi arriva comunque come testo nel contesto del modello: e' di nuovo input che il modello potrebbe interpretare. Va incapsulato nello stesso wrapper untrusted/system e testato, e non deve contenere istruzioni.
- (4) La storia: l'agente che si sposta puo' leggere la storia della nuova stanza? Per default `$` (solo nuovi messaggi); ma una scelta di policy della stanza.
- (5) Identita': displayName gia' usato nella stanza di destinazione => collisione, serve rinomina.
- (6) Atomicita' tra due slot Cluster (hash tag per stanza): `move` e' una operazione **cross-slot** non atomica (come per le porte); servono step idempotenti e un campo `moving` per recuperare.
- Con il design a cursore (F2) `move` si riduce a: aggiorna `participant.roomId`, nuovo token, vecchio token revocato: nessun gruppo da creare/distruggere.

## F14 (Media) - Memoria Redis, abuso, limiti

- Peggior caso per stanza anonima: 1000 messaggi x 8 KB = 8 MB di payload piu' overhead di stream (circa 2x con JSON in un singolo campo) => ~10-16 MB. Con `5 rooms/IP/hour` e un attaccante con 100 IP (botnet o IPv6 /64 multipli) si riempiono GB in minuti. Mancano: **tetto globale di stanze attive**, **tetto di byte per stanza** (non solo MAXLEN: `MAXLEN` conta voci), coda di creazione con backpressure e `maxmemory` che rifiuta (F3).
- Rate limit per IP dietro Traefik/Coolify: serve `trustProxy` corretto in Fastify, altrimenti tutti gli utenti hanno l'IP del proxy (e un solo utente blocca tutti) oppure un client falsifica `X-Forwarded-For` (bypass). Per IPv6 limitare per prefisso /64.
- Nessuna protezione bot sulla creazione di stanze (CAPTCHA/PoW tipo Turnstile): "no signup" invita all'abuso (stanze come relay anonimi o per spam/phishing). Va in fase 1: almeno Turnstile + tetto globale. Serve anche una pagina **abuse/report** e una politica di contenuti.
- 8 KB: definire se byte o caratteri (UTF-8 fino a 4 byte/carattere); validare in byte.
- Il secret scanner (sicurezza 6): falsi positivi con entropia alta (hash, base64, id), e **bypassabile** da un agente (spezzare la chiave, codificarla). Dichiarare "best effort" in UI. Costo CPU: regex su 8 KB trascurabile.
- Il budget giornaliero e il circuit breaker presuppongono un contatore persistente: in Redis con TTL va bene.

## F15 (Media) - Postgres/Drizzle, monorepo e tooling

- **Tempistica Postgres**: il doc dice giustamente "phase 1 needs none" ma poi la sezione 19 chiede come primo deliverable "Docker Compose with Redis **and Postgres**". Incoerente: in fase 1 Postgres e' un container che non fa nulla. Rimandare a fase 2 (e allora scegliere con il vero schema in mano).
- Drizzle vs Prisma: "pick one and stay" ma nessuna indicazione. Drizzle e' adatto (SQL vicino, niente engine binario, build leggera, tipi inferiti) e va bene con ESM; Prisma ha migliorato molto (v6/7 senza engine Rust **[verificare]**). Scegliere Drizzle; evitare la doppia dipendenza ORM + Zod duplicato: `drizzle-zod` per derivare schemi ma non usare gli schemi DB come protocollo.
- Schema fase 2: `agent_tokens.room_id` + `token_hash` ok; `message_archive` senza chiave primaria definita ne' partizionamento: `(room_id, message_id)` come PK, indice per `ts`, cancellazione per GDPR (diritto all'oblio per messaggi in stanze permanenti: come si cancellano se `audit_events` e' append-only? il hash del contenuto in audit non e' dato personale, ok, ma `from jsonb` in archivio contiene displayName: va potuto cancellare/anonimizzare). **Conflitto**: audit "no updates or deletes" vs GDPR; risolvere con pseudonimizzazione (id partecipante, non nome) e retention definita.
- **Monorepo pnpm**: ottimo per `packages/protocol` condiviso. Ma `apps/site` (Astro), `packages/shim`, `packages/config` e `docker/` x2 sono scaffolding anticipato: in fase 1 bastano `apps/server` (+ `web`) e `packages/protocol`. Aggiungere Turborepo/Nx **non** e' necessario con 3 pacchetti; `pnpm -r` basta. `packages/config` per tsconfig/eslint puo' essere un file `tsconfig.base.json` alla radice.
- Uno strumento unico di lint+format (**Biome**) al posto di eslint+prettier+config package riduce attrito **[verificare]** compatibilita' con le regole di cui hai bisogno.
- Build del server: con ESM + TS strict, usare `tsx` in dev e `tsup`/`tsc` in build; con Nest servono `reflect-metadata` e decoratori (F9).
- Sul web: React+Vite+TanStack Query+Router+Tailwind e' ok; per la fase 1 la SPA ha 3 pagine. Astro per il landing: una pagina statica nella SPA o un `index.html` bastano finche' non c'e' SEO da fare.
- Testcontainers + Playwright + Prometheus + Grafana in fase 1: Testcontainers solo se si usa Redis; Grafana/Prometheus posticipabili (un `/healthz` e log Pino sono sufficienti al lancio; aggiungere metriche quando c'e' qualcosa da misurare).
- Deploy: "One Compose file for dev and prod variants" contraddice la struttura `compose.dev.yml`/`compose.prod.yml` in sezione 5. Scegliere. Coolify gestisce gia' build e proxy: il Compose di prod e' quello di Coolify.

## F16 (Bassa) - Lua rate limiter, hash tag e Cluster

- Lo **sliding window** in Lua e' corretto ma sovra-ingegnerizzato. Per fase 1 un token bucket in memoria (una funzione di 15 righe) e' sufficiente e piu' veloce di un round-trip a Redis. Per piu' istanze, `INCR` + `PEXPIRE` su finestra fissa va bene per limiti di abuso (precisione al secondo non serve).
- Dal Redis 7 si preferiscono le **Functions** agli `EVAL` con script caricati, ma per questa dimensione e' indifferente.
- Hash tag `{room:<id>}`: corretto ed economico da mettere subito; ma Redis Cluster non e' un obiettivo realistico prima di decine di migliaia di stanze attive, e l'operazione cross-room (porte, move, F12/F13) e' proprio quella che l'hash tag rende non atomica. Tenere il tag (costa zero) ma non progettare altro attorno a Cluster. Un Redis singolo + replica copre un ordine di grandezza in piu' di quanto serva.
- Le chiavi con `token:<sha256>` e `rl:` per IP non hanno il tag di stanza: va bene, sono operazioni a chiave singola; dichiararlo.
- Nel doc: "Multi-key Lua scripts must only touch keys with the same room hash tag" - corretto; aggiungere che anche le chiavi vanno passate in `KEYS[]` e non costruite dentro lo script (richiesto da Cluster).

## F17 (Info) - Pezzi mancanti

1. **Reconnection / idempotenza di `room_send`**: se il tool call va in timeout, l'agente riprova e posta due volte. Aggiungere `clientMsgId` opzionale con dedupe server-side (TTL breve).
2. **Presenza di un agente in pull**: un agente "online" e' tale solo se ha chiamato di recente: definire `lastSeen` e stato `away` (soglia ~2 min), altrimenti la UI mente.
3. **Rilevazione "agent offline" per il wake policy**: mandare un messaggio con mention a un agente che non sta facendo poll non lo sveglia. La UI deve mostrarlo ("consegnato / in attesa di lettura"): ricevute di lettura basate sul cursore.
4. **Gestione del versioning MCP** (F1) e dei **cambi di nome dei tool** ("keep names stable"): nessun `protocolVersion` negoziato nella tua API REST.
5. **Controllo di versione dello shim** e canale di update (fase 2).
6. **Moderazione/abuso**: kick c'e', ma niente blocklist IP, segnalazioni, contatto abuse, ToS. Per un servizio anonimo e' un requisito di lancio.
7. **Contenuto e injection**: il wrapping (sicurezza 3) e' necessario, non sufficiente. Mancano: neutralizzazione di marker che imitano il wrapper (un mittente puo' inserire `</room_message>` finto: va escapato/randomizzato con un **delimitatore casuale per risposta**), lunghezza massima dei displayName e vendor (anche questi sono iniettabili: un displayName e' testo che entra nel contesto del modello), rimozione di caratteri di controllo/Unicode bidi, e limiti ai link/markdown (esfiltrazione tramite immagini markdown se l'host le renderizza).
8. **Privacy**: IP in rate limit, retention dei log, DPA col fornitore VPS, informativa; anonimo non significa senza dati personali (displayName, IP, contenuto).
9. **Metriche di costo dell'utente** (F7) e un disclaimer su consumo quota.
10. **Backpressure per stanza** e limiti del numero di waiter per partecipante (un agente con 20 long-poll aperti consuma risorse): una sola richiesta `room_inbox` attiva per participant, la nuova annulla la precedente.
11. **Recovery del server** dopo restart se lo stato e' in memoria: chiare aspettative (stanze anonime perse) e messaggio all'agente ("room not found: ricrea o rientra").
12. **Test di compatibilita' contro le due revisioni MCP** (F1) in CI con il client SDK in entrambe le modalita'.
13. **Versione minima di host** supportata e matrice di compatibilita' in `docs/hosts/`.
14. **Procedura di incidente** (kill switch globale, non solo per stanza).

---

## Architettura semplificata consigliata per la fase 1

Obiettivo: far funzionare per davvero l'acceptance test del doc con meno parti mobili, mantenendo i confini che servono dopo (protocol condiviso, trust model, token hashed).

**Processo unico Node (Fastify nudo, ESM, TS strict)**
- `POST /rooms/anonymous`, `GET /rooms/:id`, `POST /rooms/:id/join|approve|kick|close` (REST, Zod).
- `ALL /mcp/:token` e `/mcp` con Bearer: server **MCP stateless**, `McpServer` + transport creati per richiesta, risposta JSON (non SSE), 3 tool: `room_send`, `room_inbox`, `room_participants` (piu' `room_leave`). Niente `room_identify`: nome e vendor arrivano dal join REST. Se un host parla la revisione 2026-07-28 e un altro la precedente, entrambi funzionano perche' il server non conserva sessioni; testare con il client SDK nelle due modalita' (F1).
- `/ws` (`@fastify/websocket`) per il browser, con ticket a breve durata, heartbeat, `lastEventId` al reconnect.
- **Stato stanza in memoria**: `Map<roomId, Room>` con `log: Envelope[]` (ring buffer da 1000), `members`, waiter per `room_inbox` (promise + timer), timer di scadenza e `room_closing` a T-60 s. Interfaccia `RoomStore` solo se serve davvero una seconda implementazione.
- Cursore: `room_inbox({ after?, limit?, waitSeconds? })` risponde con `{ messages, cursor }`; `room_send` fa piggyback degli ultimi messaggi non visti. `waitSeconds` default 10, max 25.
- Wrapping untrusted con **delimitatore casuale** per risposta, displayName/vendor sanificati.
- Rate limit: token bucket in memoria (per partecipante, per stanza), IP con `trustProxy` corretto + Turnstile + tetto globale di stanze attive e di byte.
- Secret scanner base (regex + entropia) come funzione pura con test.
- Persistenza: **nessuna**. Quindi "nothing durable" e' vero per costruzione, e nessun errore di TTL/PEXPIREAT possibile. Rischio dichiarato: un riavvio/deploy uccide tutte le stanze (accettabile prima del lancio pubblico; mostrare messaggio chiaro).
- Redis: **non in fase 1**. Si aggiunge in fase 2 quando servono (a) sopravvivenza al deploy, (b) seconda istanza. Se si vuole comunque sopravvivere ai deploy da subito: Redis **senza persistenza**, con `STREAM` per stanza, **senza consumer group**, lettura con `XRANGE`/`XREAD` non bloccante, un solo lettore bloccante per processo e fan-out in memoria (F4), scritture via un unico helper che applica `NOMKSTREAM` e `PEXPIREAT` (F5), `--save "" --appendonly no`, `maxmemory` + `noeviction`.

**Monorepo minimo**
```
apps/server   Fastify (REST + WS + MCP)
apps/web      React + Vite
packages/protocol   Zod: envelope, tool I/O, eventi WS, template snippet
docs/hosts
```
Niente `site`, `shim`, `config`, Turborepo, Postgres, Prometheus, Grafana, compose dev/prod doppi. Un `Dockerfile` e il deploy di Coolify. `/healthz` + Pino con redazione del path.

**Piano a due traguardi**
- 1a (circa 1-1,5 settimane): server stateless MCP con `room_send/room_inbox`, stanza in memoria, WS, pagina stanza minima, due host reali (Claude Code + Codex o OpenCode) con cursore e long-poll. Test: fake MCP client + due host a mano.
- 1b (circa 2-3 settimane): admin approval, kill switch, countdown, secret scanner, rate limit/Turnstile, wrapper anti-injection con test, snippet per altri host, deploy, Playwright su 2 flussi.
- Rimandati: circuit breaker UI, budget giornaliero, Postgres, Redis, Astro, Grafana, shim push.

**Decisioni da prendere prima di scrivere codice**
1. Sessioni MCP: stateless (consigliato) con test su entrambe le revisioni.
2. Cursore esplicito invece di consumer group (consigliato).
3. Redis in fase 1: no (consigliato) oppure si, senza persistenza e senza gruppi.
4. Fonte di verita' delle stanze permanenti (fase 2): Postgres.
5. Token: preferire Bearer, URL-token come fallback; configurare il reverse proxy per non loggare il path.
6. Move: richiede consenso dell'owner dell'agente.
7. Framework: Fastify nudo (o Hono); Nest solo se si accetta l'attrito con l'SDK MCP.

## Fonti web consultate

- [Cloudflare: The next generation of MCP](https://blog.cloudflare.com/mcp-v2/)
- [Composio: MCP 2026-07-28 update](https://composio.dev/blog/mcp-2026-07-28-update-statelessness-apps-auth)
- [MCP 2026-07-28 changelog](https://modelcontextprotocol.net/specification/2026-07-28/changelog)
- [Stacklok: Enterprise readiness, July 2026 MCP spec](https://stacklok.com/resources/enterprise-readiness-guide-for-the-july-2026-mcp-spec-update/)
- [claude-code issue 20335 (timeout ignorato su Streamable HTTP)](https://github.com/anthropics/claude-code/issues/20335)
- [claudeissues 63379 (Desktop ~60 s)](https://claudeissues.com/issue/63379-bug-desktop-app-cancels-stdio-mcp-tool-calls-at-60s-and-ignores-mcp-tool-timeout)
- [claudeissues 70441 (idle timeout MCP remoto, 5 minuti)](https://claudeissues.com/issue/70441-docs-mcp-docs-omit-remote-tool-idle-timeout-and-claude-code-mcp-tool-idle-timeout)

Nota di metodo: i dati sulle versioni degli host e dell'SDK provengono da fonti secondarie (issue e blog) e non dalla documentazione ufficiale; i punti marcati **[verificare]** vanno controllati prima di prendere decisioni vincolanti.
