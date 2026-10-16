# Analisi di mercato: "Agent Office" (stanze/ufficio virtuale per coding agent cross-vendor e cross-account)

Data analisi: 2026-10-16. Base: `docs/ARCHITECTURE.md` (sezioni 1-3, 12, 18). Ricerca web eseguita con strumenti di ricerca generici e lettura diretta di alcune pagine; dove la fonte e un blog, un aggregatore o uno snippet di ricerca lo segnalo come **[NON VERIFICATO]**. Nessuna ricerca su banche dati marchi (USPTO/EUIPO/BOIP) e stata possibile: la sezione nome e quindi solo indicativa.

## 0. Verdetto in breve

**NO-GO come prodotto commerciale "generico di chat per agenti". GO condizionato (timeboxed, basso costo) solo come esperimento di nicchia**, se si accetta che:

1. Il solo trasporto di messaggi tra agenti e gia una commodity gratuita e open source (decine di repo MIT, uno con ~1,6k stelle).
2. Anthropic ha gia rilasciato nativamente messaggistica tra sessioni e agent teams; il vuoto residuo e **cross-account / cross-vendor / con persone terze**, che e esattamente la tesi del progetto, ma e un vuoto stretto e facilmente colmabile o aggirabile.
3. Esiste gia almeno un concorrente con la stessa tesi e lo stesso nome di categoria ("Agent Room", hosted, cross-owner con consenso, Claude Code/Codex/OpenClaw/Hermes) e un secondo posizionato come "virtual office for humans and agents" (Oasis, lancio Product Hunt agosto 2026).
4. La parte con piu valore difendibile (identita, consenso, anti prompt-injection, kill switch, audit, secret scanning) e quella che la sezione 11 dell'architettura gia mette al centro: il posizionamento giusto, se si prosegue, e "stanza sicura e governata tra agenti di persone diverse", non "chat per agenti".

Raccomandazione: non investire oltre la Fase 1 (2-3 settimane) finche non si ottengono segnali di domanda reali (vedi sezione 9). Non costruire mappa 2D/avatar (Fase 4) prima di avere retention.

## 1. Concorrenti e prodotti adiacenti

### 1.1 Messaggistica agente-agente via MCP (open source, locale o self-hosted)

| Progetto | Cosa fa | Traction/Prezzo | Fonte |
|---|---|---|---|
| agmsg (fujibee) | Claude Code, Codex, Gemini, Copilot si scambiano messaggi in un "team"; Bash + SQLite locale, niente daemon; modalita push `monitor` o `turn`; spawn/despawn peer | ~1,6k stelle, 164 fork, 286 issue aperte, MIT, lancio Product Hunt 2026-06-09 (dalla pagina GitHub). Gratis | https://github.com/fujibee/agmsg |
| Agent Room (agent-room-mcp, dev.to) | Server MCP open source, stanza condivisa con codice di 9 caratteri, tool `room_join/send/listen`, UI browser per umani | Gratis in beta, MIT, self-hostable; nessuna metrica visibile; autore iscritto a maggio 2026 | https://dev.to/agent-room/i-built-an-mcp-server-so-my-claude-code-and-cursor-agents-can-actually-talk-to-each-other-551b |
| Agent Room (sito tryagentroom.com) | Workspace hosted: stanze persistenti, @mention, identita "passport" verificata, task board, file sharing, collaborazione cross-owner con consenso esplicito; auto-wake per Claude Code, Codex, OpenClaw, Hermes, pull per altri MCP | Prezzi non leggibili (rimanda a pagina Pricing non recuperata); nessun claim di traction. **Non e chiaro se sia lo stesso progetto del repo dev.to [NON VERIFICATO]**: il nome coincide e la descrizione e compatibile | https://tryagentroom.com/ |
| agent-chat (TobiasCoding) | Stanza condivisa durevole Claude Code + Codex, SQLite, MCP stdio | Piccolo, MIT [NON VERIFICATO sulle metriche] | https://github.com/TobiasCoding/agent-chat-mcp |
| agent-chat (moogento) | Codex, Claude Code, OpenCode; task room, cursori non letti, attese fino a 2h, broker autenticato opzionale per container Docker | 1 stella, 0 fork, MIT, 61 commit | https://github.com/moogento/agent-chat |
| agent-peers (ThomasMarcelis) | Messaggistica locale Claude Code/Codex/Hermes | Piccolo [NON VERIFICATO] | https://github.com/ThomasMarcelis/agent-peers |
| agent-comms-mcp (watchout) | Push delivery, PostgreSQL, HMAC-SHA256 | Piccolo [NON VERIFICATO] | https://github.com/watchout/agent-comms-mcp |
| cross-agent_mcp (whooperlove) | Relay verso sessioni live Claude Code/Codex (anche VS Code) mantenendo contesto | Piccolo [NON VERIFICATO] | https://github.com/whooperlove/cross-agent_mcp |
| AgentsRoom | Pagina "agent to agent messaging" per coding agent | Pagina non leggibile (HTTP 413); prezzo ignoto | https://agentsroom.dev/features/agent-messaging |

Lettura critica: la categoria e affollata e i repo piu piccoli sono hobby. L'unico segnale quantitativo robusto e agmsg (1,6k stelle in pochi mesi), che indica **domanda reale ma soddisfatta da soluzioni locali gratuite**. Quasi tutti sono locali (stessa macchina, SQLite): il differenziale hosted/cross-macchina e reale ma non ha ancora un volume provato.

### 1.2 Funzionalita native dei vendor

- **Claude Code, Agent Teams**: sperimentale, disattivato di default (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`); teammate con mailbox JSON locale in `~/.claude/teams/...`, task list condivisa, una sola squadra per sessione, solo stesso vendor, locale alla sessione. Fonte ufficiale: https://code.claude.com/docs/en/agent-teams
- **Claude Code, cross-session messaging**: letto in documentazione ufficiale (richiede v2.1.224+; Windows nativo v2.1.234+). Un Claude puo elencare (`ListAgents`) e messaggiare (`SendMessage`) **le proprie** altre sessioni: stessa macchina via socket locale, altre macchine e cloud via server Anthropic con Remote Control (richiede login claude.ai). Ha controlli in entrata (`crossSessionInbound`: accept/hold/refuse), approvazione per messaggi fuori macchina (`isolatePeerMachines`), rate limit e anti-loop. I messaggi non possono approvare permessi. Fonte: https://code.claude.com/docs/en/cross-session-messaging
  Implicazione grave: **Anthropic ha gia implementato in modo nativo gran parte della meccanica che l'architettura sezione 10 progetta** (push in sessione idle, anti-loop, trattamento "non e l'utente", non-relay dei permessi). Resta fuori: sessioni di **altri account/persone**, altri vendor, UI web condivisa con umani.
- **Claude Code Channels** (research preview da marzo 2026): MCP server locali che spingono eventi in una sessione; Telegram, Discord, iMessage, fakechat; canali custom richiedono flag "dangerously" finche non in allowlist; Team/Enterprise richiedono abilitazione admin. Fonti: https://code.claude.com/docs/en/channels-reference, https://implicator.ai/anthropic-ships-its-openclaw-rival-connecting-claude-code-to-telegram-and-discord. Dettagli cronologia: [NON VERIFICATO] (fonti secondarie discordanti di un giorno).
- **Claude Code in Slack** (research preview da dicembre 2025): taggando @Claude in un thread parte una sessione di coding. Fonte: https://techcrunch.com/2025/12/08/claude-code-is-coming-to-slack-and-thats-a-bigger-deal-than-it-sounds . Cursor ha integrazione Slack simile; per Codex solo bot custom costruiti dai team (da fonte secondaria [NON VERIFICATO]): https://slack.com/intl/fr-fr/blog/developers/coding-agents-in-slack
- **OpenAI Codex**: subagent e custom agent GA dal 16 marzo 2026 (fonte secondaria, https://letsdatascience.com/news/openai-codex-adds-subagents-and-custom-agents-c3e4196e); schema hub-and-spoke (sub-agent riportano al parent), non peer-to-peer; limiti di concorrenza e date successive (maggio/luglio/settembre 2026) **[NON VERIFICATO]**, solo blog a bassa autorita. Nessuna evidenza di funzione ufficiale OpenAI per svegliare una sessione Codex idle da un altro agente. Confronto: https://codex.danielvaughan.com/2026/04/09/codex-vs-claude-code-multi-agent/
- **GitHub Agent HQ / Mission Control** (annunciato a Universe, ottobre 2025): console unica per assegnare e tracciare piu agenti (Copilot e di terzi: Anthropic, OpenAI, Google, Cognition, xAI) su GitHub, VS Code, mobile, CLI. Fonte: https://github.blog/news-insights/company-news/welcome-home-agents/ . Stato di rollout 2026 dei terzi: non confermato. E orchestrazione "dall'alto" di task su repo, non una stanza di conversazione tra agenti di persone diverse; ma e il vendor piu vicino a un "layer neutro".

### 1.3 Protocolli e framework

- **A2A (Agent2Agent)**: sotto la Linux Foundation; a un anno (aprile 2026) oltre 150 organizzazioni, integrazione in piattaforme Google, Microsoft, AWS (comunicato LF, auto-riportato): https://linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year . Detta v1.0 con Signed Agent Cards: fonte secondaria [NON VERIFICATO]. Una fonte parla di donazione ad AAIF il 2026-08-20, in conflitto con quella di giugno 2025 [NON VERIFICATO]. Posizionamento: MCP = agente-tool, A2A = agente-agente, complementari. A2A e orientato ad agenti servizio enterprise, non a sessioni interattive di coding CLI; nessuna evidenza che Claude Code/Codex lo supportino nativamente [NON VERIFICATO: non cercato esplicitamente]. L'ipotesi "Agent Card per stanza" (ARCHITECTURE sez. 18) e un'opzione di compatibilita, non un motore di domanda.
- **Framework multi-agente** (CrewAI, LangGraph, AutoGen ecc.): non verificati in questa ricerca; sono in-process, agenti server-side, quindi non concorrono sul caso d'uso "agenti gia in esecuzione sulle macchine di persone diverse". [NON VERIFICATO]

### 1.4 Inbox/mail per agenti

- **AgentMail** (YC S25): seed 6 M$ guidato da General Catalyst (marzo 2026), inbox email via API per agenti; piani riportati: Free (3 inbox, 3.000 email/mese), Developer 20 $/mese, Startup 200 $/mese; cifre di utenti e 500+ clienti B2B auto-riportate; prezzi con fonti discordanti [NON VERIFICATO]. Fonti: https://thenextweb.com/news/agentmail-raises-6m-seed-ai-agent-email-inboxes , https://www.eesel.ai/blog/agentmail-review . Utile come benchmark: un'infrastruttura "messaggi per agenti" ha raccolto capitale, ma usa email (identita/interop gia esistenti con il mondo esterno), non e una stanza tra coding agent.

### 1.5 "Uffici virtuali" per agenti (collisioni di categoria e di nome)

- **Oasis**: "multiplayer AI workspace", umani e agenti condividono stanze; Product Hunt 2026-08-13 (da chatgate.ai); freemium: Free 0 $ (3 seat, 10 integrazioni, 10 stanze programmate/mese, modelli open source), Starter 19 $/mese (10 seat) [fonti terze, NON VERIFICATO]. https://chatgate.ai/post/oasis , https://digg.com/tech/hsbp7a5b
- **Agent Office** (nome identico): trovati almeno un progetto open source/direttorio descritto come "hub stile Slack per coordinare piu agenti, self-hostable" (pagina di bassa qualita, [NON VERIFICATO]: https://aiindigo.com/tool/agent-office), un progetto TypeScript "AgentOffice" con pixel-art locale su Ollama, "My Virtual Office" (eliautobot, 2D self-hosted che visualizza agenti Claude Code/Codex: https://www.sourcepulse.org/projects/33027805), "AgentSubway" ("virtual office where AI agents run your work", https://hunted.space/product/agentsubway), "Virtual Agentic Office" su AWS Marketplace. Il concetto "ufficio virtuale per agenti" con mappa 2D e gia ripetuto da molti hobbisti: la Fase 4 non e differenziante.
- Adiacenti non competitivi diretti: Codi (a16z, AI office manager, ottobre 2025; azienda diversa): https://techcrunch.com/2025/10/21/a16z-backed-codi-launches-ai-agent-office-manager

## 2. Probabilita che i vendor lo rendano superfluo

Valutazione qualitativa (mia stima, non un dato):

| Scenario | Probabilita a 12 mesi | Motivazione |
|---|---|---|
| Anthropic estende messaggistica a persone/account diversi (stanze condivise tra utenti, es. via claude.ai/Teams) | Media (30-45%) | Ha gia sessioni cross-machine/cloud, Slack, Channels, Remote Control, controlli inbound, e una cultura "stesse sessioni ma sempre dello stesso utente". Il passo a "team shared session" e naturale per piani Team/Enterprise. Nessuna roadmap pubblica trovata |
| OpenAI replica funzione equivalente per Codex | Media-bassa (20-30%) | Subagent hub-and-spoke, nessun peer messaging ufficiale trovato |
| Nessuno dei due supporta **cross-vendor** nativamente | Alta (>75%) | Incentivo strutturale: ogni vendor vuole tenere l'agente dentro il proprio ecosistema; il cross-vendor lo faranno protocolli (A2A) o terzi |
| GitHub (Agent HQ) diventa il layer neutro multi-vendor per task su repo | Media (35-50%) | Ha gia l'annuncio e i partner; ma e task-centrico (issue/PR), non conversazionale |

Conclusione: **il solo "cross-account stesso vendor" e a rischio alto di essere assorbito**; **il "cross-vendor" e protetto strutturalmente ma e anche l'area con meno utenti** (chi usa due vendor insieme e una minoranza power user). Rischio ulteriore di piattaforma: Anthropic ha vietato a febbraio 2026 l'uso di token OAuth di abbonamento in strumenti terzi e ha adottato blocchi lato server dal 9 gennaio 2026 (fonti secondarie: https://gigazine.net/gsc_news/en/20260220-anthropic-third-party-block , https://falcao.org/posts/anthropic-claude-access-crackdown-ecosystem-fallout/; dettagli maggio/giugno su crediti separati [NON VERIFICATO], nessuna pagina primaria letta). Il design Agent Office evita il problema (non tocca credenziali), ma dimostra che i vendor sorvegliano attivamente tutto cio che si frappone fra abbonamento e agente. Da verificare con legale se "relay verso un harness ufficiale" resti conforme a ogni vendor.

Rischio tecnico di dipendenza: il push verso agenti idle e il cuore dell'esperienza. Le fonti mostrano problemi noti: MCP e request-response e l'agente vede il messaggio solo al turno successivo; notifiche di canale bufferizzate quando l'agente e idle (https://claudeissues.com/issue/63452-channel-notifications-notifications-claude-channel-buffered-instead-of-injected , https://claudeissues.com/issue/36665-feat-mcp-server-push-notifications-unsolicited-messages-to-client). Questo e un vincolo per il design del progetto: la modalita `pull` (default dell'architettura) significa "gli agenti non si sentono finche non fanno un turno". Il valore percepito, a differenza di una chat umana, risulta degradato proprio sui vendor non-Claude.

## 3. Utenti target e segnali di domanda

Segnali reali (qualitativi):
- agmsg: 1,6k stelle e lancio Product Hunt; richiesta GitHub marzo 2026 per un bridge Claude Code Channels verso Codex (https://claudeissues.com/issue/36871-feature-claude-code-channels-mcp-openai-codex-app-server-in-the-same-live-sessio); commenti HN e blog su copia-incolla manuale tra Claude e Codex per cross-check (aggregati in https://medium.com/@yingjunwu/agent-to-agent-communication-is-broken-why-an-email-like-inbox-model-works-3ac15cfe7085, https://zeli.app/en/story/48936534) **[aneddotici]**.
- Una dozzina di repo nuovi tra 2026-03 e 2026-10 con la stessa idea: indica sia domanda sia **assenza di una soluzione dominante e di barriere di ingresso**.

Segnali mancanti: nessun dato di pagamento, nessuna evidenza di utenti disposti a pagare per messaggistica agente-agente, nessun caso aziendale pubblico. Nessun prezzo trovato per i concorrenti hosted dedicati (Agent Room) oltre a Oasis (19 $/mese, fonte terza).

Segmenti plausibili, in ordine di realismo:
1. **Power user individuale multi-vendor** (Claude Code + Codex sulla stessa macchina o su due): bisogno reale ma servito da soluzioni locali gratuite. Disponibilita a pagare: bassa.
2. **Coppie/piccoli team ad hoc cross-organizzazione** (freelance + cliente, due studi, due maintainer open source, pair programming "ciascuno col suo agente"): il caso unico dove "cross-account e senza signup" ha senso; frequenza di uso: bassa e episodica, ma onboarding a 1 copia-incolla e un buon gancio virale.
3. **Team con policy** (security/compliance) che vogliono tracciabilita delle comunicazioni agente-agente: il valore e alto, ma questo e il segmento Enterprise/governance, dove i vendor (Anthropic Teams, Microsoft Agent 365: https://learn.microsoft.com/en-us/microsoft-agent-365/builder/agent-registry ) corrono piu veloce e dove un singolo operatore EU senza track record non ha vantaggio di fiducia.
4. Eventi/hackathon/workshop: uso a stanze temporanee da 1h, ottimo per demo, ricavo ~0.

## 4. Posizionamento

Posizionamento consigliato (se si prosegue): **"Una stanza neutra e sicura dove gli agenti di persone diverse, su vendor diversi, possono parlarsi, con approvazione umana, audit e kill switch."**

Da evitare:
- "Chat per agenti" (commodity, 12+ repo gratuiti).
- "Ufficio virtuale 2D" (molti hobby/piccoli concorrenti, effetto wow senza retention).
- "Piattaforma multi-agente" (framework e vendor lo coprono).

Differenziatori realmente difendibili, in ordine:
1. Cross-account senza account e senza chiavi, onboarding in un comando (gia progettato).
2. Sicurezza by default: envelope untrusted, secret scanning in uscita, wake policy a menzioni, circuit breaker (sez. 11). Nessun concorrente trovato ne fa un punto di vendita esplicito (Agent Room cita "identita verificata e consenso", quindi competono parzialmente su questo punto).
3. Neutralita fra vendor, anche con host a solo pull.

Nota critica: il differenziatore 2 e anche un costo: ogni controllo di sicurezza riduce la fluidita ("block e spiega" sui secret, approvazioni di join) e il settore premia chi e semplice. Vale la pena misurare l'attrito in beta.

## 5. Go-to-market

- Canale primario: **developer-led, open source**. Pubblicare protocollo/shim (e idealmente il server) con licenza permissiva o AGPL, README con "due agenti, due macchine, 60 secondi". Distribuzione tramite directory MCP (Glama, ecc.), Show HN, Product Hunt, Reddit r/ClaudeAI r/ChatGPTCoding, discord dei tool, e pagine docs per host (le `docs/hosts/` dell'architettura sono gia un asset SEO).
- Il gancio virale e naturale: ogni stanza richiede un invito a un'altra persona. Misurare il k-factor (inviti accettati / stanze create).
- Contenuto: casi d'uso concreti ("fai fare review del tuo Claude dal Codex del collega", "dibattito multi-vendor su un bug").
- Non perseguire enterprise nei primi 6 mesi. A2A e un'opzione di credibilita ma non vende da sola.
- Rischio di timing: lanciare dopo agmsg (giugno 2026), Oasis (agosto 2026) e Agent Room; il vantaggio "primo arrivato" non esiste.

## 6. Monetizzazione

Opzioni, con giudizio:

| Opzione | Giudizio |
|---|---|
| Freemium SaaS (stanze permanenti, storico, team) | Standard del settore (Oasis free/19 $; AgentMail free/20 $); prezzo ancorato bassissimo; bassa propensione a pagare per un relay di testo. Fattibile, ricavi piccoli |
| Self-hosted a pagamento / licenza commerciale | Plausibile per team con vincoli di dati, ma il concorrente "SQLite locale" e gratuito; vendere solo se si includono SSO/audit/retention |
| Open core: server open source, hosted + governance a pagamento | Probabilmente la forma piu sensata |
| Enterprise (audit, SSO, A2A, policy engine) | Valore reale ma ciclo di vendita lungo e concorrenza di vendor; non adatto al primo anno |
| Ads/dati | Escluso (principio di privacy dell'architettura e GDPR) |
| Pay-per-message / usage-based | Non coerente con la promessa "non gestiamo i costi di inferenza"; costo marginale reale basso |

Ordine di grandezza: con prezzi di riferimento 19-20 $/mese e un tasso di conversione tipico free->paid dell'1-3% [assunzione mia, NON VERIFICATO], per 1.000 EUR di MRR servono circa 50 paganti, cioe 2.000-5.000 utenti attivi mensili. La VPS e il costo infrastrutturale sono trascurabili; il costo vero e il tempo e il supporto per i vari host (ciascuno cambia "settimanalmente", come ammette l'architettura sez. 1).

## 7. Sanity check dei limiti free (ARCHITECTURE sez. 12)

- Anonima: 1h, 5 agenti, 5 umani, 8 KB, 60 msg/min, 1000 messaggi, 5 stanze/ora/IP. Ragionevole come demo; 60 msg/min per stanza e **molto alto** per agenti che ciascuno e un modello a pagamento: il rischio non e il nostro costo ma il costo token degli utenti (ogni wake e un turno, sez. 10). Raccomandazione: abbassare il default di messaggi che causano wake e mostrare un contatore di costo stimato; tenere 60 msg/min solo come tetto di abuso.
- Permanente free: 10 agenti, 20 umani, 120 msg/min, 10k storia archiviata in Postgres. Tetto generoso rispetto ai concorrenti (Oasis free: 3 seat). Rischio: abuso come canale di trasferimento dati o bot spam e costo di archivio Postgres; limitare numero di stanze permanenti free (es. 3) e retention (es. 30 giorni) finche non c'e un piano a pagamento. Un free tier che include 20 umani + archivio illimitato non lascia motivo di pagare.
- Rate per IP 5/ora: OK, aggira facile con VPN; serve captcha/pow leggero. Per un servizio senza signup, l'abuso (spam di stanze, uso come relay per prompt injection verso terzi) e il rischio operativo principale, non il costo.
- Responsabilita: un relay anonimo che inoltra testo non fidato a agenti che eseguono codice e un vettore di attacco ideale; un incidente pubblico (prompt injection via stanza) avrebbe costi reputazionali alti per un solo operatore. La sezione 11 e adeguata come intento, ma e da considerare costo fisso di prodotto, non opzionale.

## 8. Nome e marchio

- Il nome "Agent Office" e **descrittivo e gia in uso** da almeno 4-5 progetti/liste (vedi 1.5), incluso un progetto con il nome identico descritto come hub per coordinare agenti. Quindi: bassa distintivita, rischio di confusione, SEO poco praticabile ("agent office" e anche "office" nel senso Microsoft Office; i risultati di ricerca sono dominati da altro), difficile registrare un marchio descrittivo (UE: motivo assoluto di rifiuto per descrittivita probabile) **[valutazione mia, non consulenza legale]**.
- Nessuna ricerca su USPTO/EUIPO/WIPO/BOIP/domini e stata eseguita: **da fare prima di impegnare brand e dominio**. Controllare almeno: classi 9, 42, 38; domini .com/.io/.dev/.ai; handle GitHub/npm/X.
- Regola gia nel documento: niente "Claude", "Anthropic", "Codex", "OpenAI", "GitHub", "Copilot", "Gemini" nel nome, dominio, logo, pacchetti npm (anche i pacchetti npm e i plugin: i marketplace dei vendor possono rimuoverli). Estendere la regola a: niente "MCP" come parte distintiva del nome (marchio della Linux Foundation/AAIF? **[NON VERIFICATO]**), niente "Office" in modo che richiami Microsoft Office. Indicare compatibilita solo in testo semplice e usi nominativi ("works with ...") con disclaimer di non affiliazione.
- Suggerimento: scegliere un nome inventato o evocativo e distintivo (non descrittivo), con dominio e handle liberi; "Agent Room" e "Agent Office" sono entrambi gia occupati nello spazio.

## 9. Raccomandazioni operative

1. **Non fare ancora il lavoro di Fase 2-4.** Eseguire solo Fase 1 come esperimento di 3 settimane con criteri di uscita espliciti.
2. **Validazione prima del codice (1 settimana, costo quasi zero):** (a) provare davvero Agent Room, agmsg, Oasis e confrontare l'onboarding con quello previsto; (b) landing page + comando di onboarding finto e mailing list; (c) 10 interviste a utenti multi-vendor e a freelance/consulenti che lavorano con agenti.
3. **Criteri go/no-go dopo il lancio Fase 1** (da fissare ora, valori indicativi miei): >=300 stanze create in 30 giorni, >=25% con almeno 2 owner distinti, >=10% di stanze con piu di 2 sessioni di scambio, >=5 utenti che chiedono stanze permanenti spontaneamente. Sotto soglia: fermarsi o ridurre a progetto open source.
4. **Ridurre il perimetro tecnico** coerentemente con il rischio: la complessita (NestJS + Redis Streams + Postgres + Drizzle + Astro + Coolify) e sovradimensionata per un esperimento il cui rischio principale e di domanda, non di scala. Una singola istanza stateless con Redis (o anche in-memory per l'anonimo) basterebbe per la Fase 1.
5. **Differenziare su sicurezza e governance**, pubblicare un threat model e il test di prompt injection (gia nei criteri di accettazione): e l'unico argomento comunicativo non copiabile in un weekend da un hobbista.
6. **Fare un check legale/ToS per vendor** sul flusso (messaggi tra sessioni ufficiali) e sull'uso di token in URL, prima di dire pubblicamente "funziona con ...". Tenere traccia delle policy Anthropic su harness terzi (cambiano spesso).
7. **Monitorare i segnali di assorbimento**: release notes di Claude Code (cross-session messaging verso altri utenti), Codex, GitHub Agent HQ. Se Anthropic apre messaggistica tra account diversi, il caso "stesso vendor" scompare e rimane solo cross-vendor.
8. **Decisioni aperte della sez. 18**, mie raccomandazioni: (a) nome nuovo e distintivo; (b) tier free restrittivo come in sez. 7; (c) transcript download per il creatore: si, se solo client-side/in memoria prima della scadenza, riduce l'attrito senza archivio server; (d) tool condivisi nelle stanze: no, mantenere fuori scopo; (e) A2A: rimandare, valutare solo su richiesta concreta; (f) self-hosted: open source del core e il modo piu rapido per costruire fiducia e distribuzione, ma riduce la barriera alla copia: scegliere AGPL o BSL se si vuole monetizzare l'hosted.

## 10. Limiti di questa analisi

- Ricerca generale via motore di ricerca; molte fonti sono blog, aggregatori o snippet. Cifre di traction (stelle, utenti, finanziamenti) sono auto-riportate o di terzi.
- Non ho letto la pagina Pricing di Agent Room, ne la pagina prezzi di Oasis, ne i Terms vendor primari (solo secondari).
- Non ho verificato i framework multi-agente (CrewAI/LangGraph ecc.), ne bot Discord specifici per coding agent, ne stato A2A negli agenti CLI.
- Nessuna ricerca di marchi o domini; nessuna consulenza legale.
- Le percentuali di probabilita (sezione 2) e le soglie (sezione 9) sono giudizi miei, non misurazioni.
