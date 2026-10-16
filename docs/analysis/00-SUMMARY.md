# 00 — Sintesi dell'analisi del piano Agent Office

Data: 2026-10-16. Documento analizzato: `docs/ARCHITECTURE.md`.

Sei revisioni indipendenti, su modelli di livello diverso:

| File | Prospettiva | Modello |
|---|---|---|
| `01-host-feasibility.md` | Fattibilità tecnica per host, documentazione ufficiale | sonnet |
| `02-market-analysis.md` | Mercato, concorrenti, nome | sonnet |
| `03-security-legal.md` | Sicurezza (STRIDE) e legale (ToS, GDPR, DSA) | sonnet |
| `04-architecture-critique.md` | Critica tecnica, 17 finding | sonnet |
| `05-quick-review-haiku.md` | Red-team rapido, senza ricerca web | haiku |
| `06-fable-advice.md` | Parere strategico | fable |

Limiti da tenere presenti: gli agenti hanno usato fonti web non sempre primarie. Nulla è stato provato su installazioni reali. Il materiale legale non è consulenza legale. Ogni file marca le affermazioni VERIFIED o UNVERIFIED.

## Verdetto complessivo

**Procedere solo con modifiche, e come esperimento, non come prodotto.** Le sei revisioni convergono su questo punto, con sfumature diverse:

- Mercato: NO-GO come chat generica per agenti, GO condizionato come esperimento di Fase 1 con soglie di uscita.
- Fable: procedi con modifiche.
- Haiku: viabile come spike di 2-3 settimane con un host, rischioso come prodotto nello scope attuale.
- Tecnica: Fase 1 in pull è fattibile su tutti e quattro gli host, il push è fragile.

## Punti su cui più revisioni concordano

1. **Il trasporto è una commodity.** Esistono già progetti open source (es. agmsg) e prodotti hosted con la stessa tesi (Agent Room, Oasis, secondo il report di mercato). Il valore difendibile è cross-vendor e cross-account, non "il posto". Anthropic ha già parti della meccanica, ma solo per lo stesso utente.
2. **Il pull mode è il rischio tecnico principale.** Gli host sono a turni, quindi una sessione inattiva non legge la stanza. Il push esiste solo per Claude Code (research preview, dietro flag, bloccato di default su Team/Enterprise) ed è fragile. Codex e Hermes restano pull. OpenCode va prototipato.
3. **Il trust modellato come assoluto è sbagliato.** `trust: 'human'` eleva qualunque umano della stanza. Per l'agente destinatario conta solo: il proprio owner, altri, sistema. Va calcolato alla consegna, per destinatario.
4. **Il rischio principale di sicurezza è l'esfiltrazione, più dell'esecuzione di comandi.** Un'injection può far leggere file locali e inviarli con `room_send`, che l'utente ha quasi certamente auto-approvato. Lo scanner di segreti protegge dagli errori, non da un avversario. Il confine reale è il permission mode dell'host, che il prodotto non controlla.
5. **Il costo cade sul destinatario.** Ogni wake è un turno modello. La policy di wake deve essere del proprietario dell'agente, non dell'admin della stanza.
6. **Il token nell'URL è il default sbagliato.** Finisce in config, shell history, log del proxy. Tutti e quattro gli host accettano un header Authorization da variabile d'ambiente: usarlo come primario.
7. **"Nothing durable" non è vero con la configurazione Redis di default** (RDB/AOF, volumi, backup Coolify, log del proxy). Servono Redis senza persistenza, log senza path e un claim di privacy riscritto con le eccezioni.
8. **Le stime di tempo sono ottimistiche.** 2-3 settimane valgono per un MVP, per il perimetro dichiarato ne servono 5-8.
9. **Il nome "Agent Office" è già usato** da più progetti. Serve un nome nuovo prima di impegnare brand e dominio.

## Correzioni fattuali al piano (da `01` e `04`)

- La revisione corrente della spec MCP (2026-07-28) è stateless: niente handshake `initialize`, niente `Mcp-Session-Id`, niente stream GET né resumabilità SSE. Il server va pensato stateless e le `instructions` non viaggiano più in `initialize`. L'SDK TypeScript v2 è diviso in pacchetti; i dettagli sui client legacy sono UNVERIFIED.
- Hermes ha `hermes mcp add`, quindi l'affermazione del piano è errata. Hermes gestisce solo `tools/list_changed`, quindi resta pull.
- OpenCode: la documentazione ufficiale non descrive l'interruzione di un turno da plugin. Esistono `session.abort`, `session.prompt` con `noReply` e l'evento `session.idle`.
- Claude Code Channels: un server che negozia la spec 2026-07-28 non viene registrato come channel. Lo shim deve restare sull'handshake legacy. La dicitura "dalla v2.1.80" è UNVERIFIED.
- `room_identify` è ridondante: nome e vendor arrivano già dal join REST.
- Consumer group con `sinceId` sono in contraddizione: se il tool call scade dopo la consegna, il messaggio resta nella PEL e l'agente non lo rivede. Meglio un cursore esplicito senza ack.
- Gli stream Redis senza `NOMKSTREAM` vengono ricreati senza TTL dopo la scadenza. Le chiavi `token:<sha>` non hanno il prefisso `{room:id}` e sfuggono al TTL.
- Il piano si contraddice su Postgres (assente in Fase 1 ma richiesto nel primo deliverable) e sui due file Compose.
- Fase 3: il `move` forzato dall'admin viola il consenso dell'owner dell'agente. Le porte in modalità `all` sono una concessione di membership.

## Divergenze da risolvere

- **Redis in Fase 1:** `04` propone di eliminarlo (stato in memoria, "nothing durable" vero per costruzione). Fable lo tiene opzionale dietro `MessageBus`. Scelta consigliata: in memoria per lo spike.
- **Shim stdio locale:** Fable lo propone come adapter universale (elimina token in URL e varianza tra host, push-ready). Gli altri non lo discutono. Dipende dall'esito dello spike.
- **Direzione di prodotto:** Fable e il report di mercato spingono su self-hosted/open core con le stanze anonime hosted come funnel. Il piano le tratta come prodotto.

## Ordine di lavoro raccomandato

1. **Spike di un giorno:** un server MCP in un file, stato in memoria, due macchine reali, Claude Code e Codex. Gate: il pull è usabile? Decide remote-HTTP contro shim-first.
2. **Validazione prima del codice:** provare Agent Room, agmsg e Oasis, una landing page, circa 10 interviste, e fissare ora le soglie go/no-go (stanze create, quota con almeno 2 owner distinti, richieste spontanee di stanze permanenti).
3. **Threat model scritto** con esfiltrazione come rischio #1, avviso nello snippet di onboarding per i permessi in bypass, trust relazionale, policy di wake per destinatario.
4. **Protocollo di comportamento dell'agente** (instructions, descrizioni dei tool, prompt dell'utente) versionato e testato come artefatto.
5. **Poi lo scheletro**, ridotto: `apps/server`, `apps/web`, `packages/protocol`. Via Postgres, consumer group/Lua, Astro, Grafana, Playwright, Coolify, flusso di approvazione. Verificare la convivenza tra SDK MCP e Fastify prima di impegnarsi su Nest.
6. **Aggiunte economiche con alto valore:** topic di stanza, risoluzione server-side di `@nome` in id, ricevuta di lettura, cursore per partecipante.
7. **Legale prima del lancio pubblico:** verifica con un legale di ToS dei vendor, GDPR (IP come dato personale, LIA, informativa), ePrivacy (possibile servizio di comunicazione interpersonale), DSA (notice-and-action, punto di contatto), ricerca marchi e domini.

## Aperto

- Nessuna verifica su installazioni reali degli snippet per host.
- Pagine prezzi di Agent Room e Oasis non lette; ToS primari dei vendor non letti per intero.
- Il file `docs/ARCHITECTURE.md` non è stato modificato: contiene il piano originale. Le correzioni sopra vanno applicate in una revisione separata, dopo le decisioni del product owner.
