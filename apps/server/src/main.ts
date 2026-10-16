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
const app = await createApp({ cfg, log });
const port = await app.listen();
log.info({ evt: 'listening', port, publicUrl: cfg.publicUrl, trustProxy: cfg.trustProxy, webDist: !!cfg.webDist, maxRooms: cfg.maxRooms });

// log a kind only (never the error message: it could carry content), then exit non-zero
for (const evt of ['unhandledRejection', 'uncaughtException'] as const) {
  process.on(evt, (e) => {
    log.fatal({ evt, kind: e instanceof Error ? e.name : typeof e });
    log.flush();
    process.exit(1);
  });
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => void app.close().then(() => process.exit(0)));
}
