// Fails if tracked files look like they contain real credentials.
// A guard rail, not a replacement for GitHub secret scanning / push protection.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const patterns = [
  ['Google API key', /AIza[0-9A-Za-z_-]{35}/],
  ['Private key block', /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['Stripe-style live key', /\b(sk|rk)_live_[0-9A-Za-z]{16,}/],
  ['Slack token', /xox[baprs]-[0-9A-Za-z-]{10,}/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
];
const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { encoding: 'utf8' }).split('\n').filter(Boolean);
const tracked = files.filter((f) => !f.startsWith('node_modules/') && !/\.(png|jpg|woff2?|ico)$/.test(f));
const forbiddenFiles = tracked.filter((f) => /(^|\/)\.env($|\.(?!example$))/.test(f));
const hits = [];
for (const f of tracked) {
  let text;
  try {
    text = readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  for (const [name, re] of patterns) if (re.test(text)) hits.push(`${f}: ${name}`);
}
if (forbiddenFiles.length || hits.length) {
  for (const f of forbiddenFiles) console.error(`env file must not be committed: ${f}`);
  for (const h of hits) console.error(`possible secret: ${h}`);
  process.exit(1);
}
console.log(`no secrets found in ${tracked.length} files`);
