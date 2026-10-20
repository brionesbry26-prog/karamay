// Copies self-hosted Montserrat (SIL OFL 1.1) into web/assets/fonts so the
// client never loads fonts from a third-party CDN (no visitor IPs leak to it).
import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const src = path.join(path.dirname(require.resolve('@fontsource/montserrat/package.json')), 'files');
const dest = path.resolve('web/assets/fonts');
await mkdir(dest, { recursive: true });
for (const w of [400, 500, 600, 700]) {
  await copyFile(path.join(src, `montserrat-latin-${w}-normal.woff2`), path.join(dest, `montserrat-latin-${w}-normal.woff2`));
}
await copyFile(path.join(path.dirname(src), 'LICENSE'), path.join(dest, 'LICENSE-Montserrat.txt'));
console.log('fonts copied to web/assets/fonts');
