// Fills placeholder secrets in .env (works on Windows, macOS, Linux).
// Only empty or CHANGE_ME values are replaced: an existing DATA_ENCRYPTION_KEYS
// is never overwritten, because data encrypted with it would become unreadable.
// Values are never printed.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const generators = {
  DATA_ENCRYPTION_KEYS: () => `1:${randomBytes(32).toString('base64')}`,
  IP_HASH_KEY: () => randomBytes(32).toString('hex'),
};
// A malformed encryption key can never have encrypted data (the app refuses to start with one), so it is safe to replace.
const validKeys = (v) =>
  v.split(',').every((part) => {
    const [id, b64] = part.split(':');
    return /^\d+$/.test(id ?? '') && Buffer.from((b64 ?? '').trim(), 'base64').length === 32;
  });
const isPlaceholder = (v, name) =>
  v.trim() === '' || /CHANGE_ME/.test(v) || (name === 'DATA_ENCRYPTION_KEYS' && !validKeys(v)) || (name === 'IP_HASH_KEY' && v.trim().length < 32);

if (!existsSync('.env')) {
  console.error('No .env file here. Create it first:  cp .env.example .env   (PowerShell: Copy-Item .env.example .env)');
  process.exit(1);
}

const eol = readFileSync('.env', 'utf8').includes('\r\n') ? '\r\n' : '\n';
const lines = readFileSync('.env', 'utf8').split(/\r?\n/);
const seen = new Set();
for (let i = 0; i < lines.length; i++) {
  const m = /^([A-Z_]+)=(.*)$/.exec(lines[i]);
  if (!m || !(m[1] in generators)) continue;
  seen.add(m[1]);
  if (isPlaceholder(m[2], m[1])) {
    lines[i] = `${m[1]}=${generators[m[1]]()}`;
    console.log(`[secrets] generated ${m[1]}`);
  } else {
    console.log(`[secrets] kept existing ${m[1]}`);
  }
}
for (const name of Object.keys(generators)) {
  if (!seen.has(name)) {
    lines.push(`${name}=${generators[name]()}`);
    console.log(`[secrets] added ${name}`);
  }
}
writeFileSync('.env', lines.join(eol));
console.log('[secrets] .env updated');
