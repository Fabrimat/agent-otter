import type { AddressInfo } from 'node:net';
import { createApp } from './app.js';
import { loadConfig, type Config } from './config.js';
import { createLogger } from './log.js';

let cfg: Config;
try {
  cfg = loadConfig();
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
const log = createLogger(cfg.logLevel);
let app: Awaited<ReturnType<typeof createApp>>;
try {
  app = await createApp({ cfg, log }); // migrations and permanent-room rehydration happen here, before listen
} catch (e) {
  log.fatal({ evt: 'boot_failed', kind: e instanceof Error ? e.name : typeof e }); // kind only: a driver message can carry connection details
  log.flush();
  process.exit(1);
}
const port = await app.listen();
log.info({ evt: 'listening', host: (app.server.address() as AddressInfo).address, port, publicUrl: cfg.publicUrl, trustProxy: cfg.trustProxy, webDist: !!cfg.webDist, maxRooms: cfg.maxRooms,
  persistence: !!cfg.databaseUrl });

// log a kind only (never the error message: it could carry content), then exit non-zero
for (const evt of ['unhandledRejection', 'uncaughtException'] as const) {
  process.on(evt, (e) => {
    log.fatal({ evt, kind: e instanceof Error ? e.name : typeof e });
    log.flush();
    process.exit(1);
  });
}

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    setTimeout(() => process.exit(0), 5000).unref(); // hard stop: never hang past 5 s
    void app.shutdown().then(() => process.exit(0));
  });
}
