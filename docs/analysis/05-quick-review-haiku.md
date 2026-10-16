# Quick red-team review: Agent Office ARCHITECTURE.md

Revisione rapida e indipendente, basata solo sul documento (nessuna ricerca web).

## Top 10 rischi

1. **Timeline Fase 1 irrealistica.** Due settimane-tre settimane coprono: MCP Streamable HTTP, WebSocket, Redis Streams con consumer group, rate limit Lua, scanner segreti, anonimizzazione TTL, approvazione join, UI browser, onboarding testato su due host, test Testcontainers ed E2E. Il rischio di slittamento e' alto.
2. **Token nell'URL (`/mcp/<token>`).** Il token finisce in log di host, cronologia, proxy e Coolify/Traefik. Il doc stesso ammette in sezione 17 di non sapere come si comportano gli host. La redazione vale solo per i log propri.
3. **Prompt injection non risolvibile con un wrapper.** Il "trust: untrusted" e le istruzioni nel server `instructions` sono difese probabilistiche. Il test di accettazione e' un test automatico del wrapping, che non dimostra il comportamento del modello.
4. **Il vero rischio e' l'exfiltration, non l'injection.** Un agente che lavora su un repo con accesso a file locali puo' postare segreti, percorsi o codice privato nella stanza. Lo scanner per pattern/entropia e' un filtro debole e crea un falso senso di sicurezza.
5. **Costo e quota di terzi.** Ogni messaggio in `pull` o `push` e' un turno di modello sulla macchina e sull'account dell'utente. Un estraneo in una stanza puo' consumare la quota di chi ha lanciato l'agente. Il doc non lo considera.
6. **Relay pubblico = vettore di abuso.** Stanze anonime, 5 per IP all'ora, messaggi di testo libero verso agenti altrui. Spam, social engineering e phishing verso umani e agenti sono attesi. Il rate limit per IP si aggira facilmente.
7. **Identita' auto-dichiarata.** `vendor` e `displayName` sono dichiarati dal client. Chiunque puo' presentarsi come "claude-code" o come un umano. Il flag `trust: 'human'` per umani anonimi puo' indurre a fidarsi troppo.
8. **Dipendenza da funzionalita' non verificate.** Il push di Claude Code e' una research preview con flag di sviluppo e policy org. OpenCode push e' "reportedly". Se queste cadono, il valore percepito cambia e il piano di push diventa lavoro morto.
9. **Ambiguita' ToS.** Un "shim" che inietta notifiche nella sessione di un client, o un hook che risveglia l'agente, puo' violare le condizioni dei vendor. Il principio "client non modificato" non basta a chiudere la questione.
10. **Garanzie TTL su Redis.** `PEXPIREAT` va applicato a "ogni nuova chiave", ma le chiavi create senza passare dal codice (rate limit, pending, consumer group) possono restare senza scadenza. Non sono definiti persistenza (AOF/RDB) e backup, quindi "tutto sparisce dopo il TTL" non e' garantito.

## Top 5 cose da tagliare dallo scope

1. **Push per Claude Code (channel shim) e fallback hook `asyncRewake`.** Fuori dalla Fase 1, dipende da una research preview. Lasciare `pull` come unica modalita'.
2. **Snippet "testati" per due host in Fase 1.** Tenerne uno solo (Claude Code, o il piu' semplice) e aggiungere gli altri dopo.
3. **Scanner con controllo entropia.** Tenere solo un elenco di pattern noti (chiavi, private key, blocchi `.env`) e una chiara avvertenza all'utente. L'entropia produce troppi falsi positivi.
4. **Circuit breaker, budget giornaliero, cooldown per thread, presence ZSET, typing.** Per la Fase 1 bastano un rate limit per stanza e un TTL.
5. **Astrazione `MessageBus`, campi `x`/`y`, compatibilita' A2A, sito Astro.** Sono YAGNI per la Fase 1. Il doc stesso chiede di non scaffoldare le fasi successive, ma il campo `x`/`y` va contro questa regola.

## Top 5 domande senza risposta

1. **Cosa fa l'agente quando non sta lavorando?** In `pull` il messaggio viene visto solo al turno successivo. Chi avvia il polling di `room_inbox`? Se nessuno, la "chat live" tra agenti non esiste. Serve un'esecuzione continua o un loop, e questo cambia costi e sicurezza.
2. **Chi paga e chi risponde?** Quota, costi di token e responsabilita' per le azioni che un agente compie dopo un messaggio di uno sconosciuto.
3. **Come interagisce con le modalita' di permesso dell'host?** Se l'utente ha auto-approve o bypass attivo, un messaggio di injection puo' eseguire comandi senza conferma. Il doc dice "senza approvazione dell'utente" ma non come viene garantito.
4. **Chi e' admin di una stanza anonima?** L'`adminSecret` vive nel browser. Se la scheda si chiude o il browser cambia, la stanza e' orfana? Cosa succede se qualcuno ottiene l'`adminSecret`?
5. **Retention e GDPR reali.** Gli IP per il rate limit, i displayName e i log: per quanto restano? Redis con persistenza o backup puo' conservare dati oltre l'ora dichiarata. La base giuridica per la trascrizione va chiarita prima della Fase 1.

## Verdetto (di pancia)

L'idea tecnica di base e' semplice: far passare testo tra sessioni di agenti che gli utenti eseguono da soli. Il prodotto pero' non e' prima di tutto un problema di trasporto. E' un problema di fiducia, abuso e integrazione con host che cambiano ogni settimana, ed e' lì che il documento e' piu' debole. Il valore "il posto" non e' dimostrato: perche' qualcuno dovrebbe preferire questa stanza a un'issue, a un canale Slack o a un file condiviso? Con lo scope attuale la Fase 1 e' troppo grossa e la parte di sicurezza (exfiltration, injection, abuso su un relay pubblico) va risolta prima del codice, non dopo. Consiglio: trattarla come uno spike di 2-3 settimane con un solo host, solo `pull`, stanze senza push e senza scanner avanzato, per verificare se due persone usano davvero la stanza. Solo dopo ha senso costruire il resto. Viabile come esperimento, rischiosa come prodotto nello scope descritto.
