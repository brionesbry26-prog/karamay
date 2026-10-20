import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';

async function main() {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    // Configuration problems name the variable, never its value.
    console.error(err instanceof ConfigError ? err.message : 'Failed to load configuration');
    process.exit(1);
  }
  const { app } = await buildApp({ cfg });
  if (!cfg.accountsEnabled) app.log.warn({ evt: 'startup' }, 'accounts disabled (no mailer configured): guest mode only');
  if (!cfg.ai.enabled) app.log.warn({ evt: 'startup' }, 'AI disabled (AI_ENABLED is not true)');

  const shutdown = async (signal: string) => {
    app.log.info({ evt: 'shutdown', signal }, 'shutting down');
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: cfg.host, port: cfg.port });
}

void main();
