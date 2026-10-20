import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { purgeExpired } from './retention.js';

const cfg = loadConfig();
const db = createPool(cfg);
purgeExpired(db, cfg.limits.retention)
  .then((counts) => console.log(JSON.stringify({ evt: 'retention_purge', ...counts })))
  .catch((err: Error) => {
    console.error(JSON.stringify({ evt: 'retention_purge_failed', err: err.message }));
    process.exitCode = 1;
  })
  .finally(() => db.end());
