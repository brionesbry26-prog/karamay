// Copies self-hosted Montserrat (SIL OFL 1.1) into web/assets/fonts so the
// client never loads fonts from a third-party CDN (no visitor IPs leak to it).
// If the font package is missing, warn and continue: the CSS falls back to system fonts.
import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
let pkgDir;
try {
  pkgDir = path.dirname(require.resolve('@fontsource/montserrat/package.json'));
} catch {
  console.warn(
    '[fonts] @fontsource/montserrat is not installed, so system fonts will be used. ' +
      'Run "npm install" (with dev dependencies; NODE_ENV must not be "production") to get Montserrat.',
  );
  process.exit(0);
}
const src = path.join(pkgDir, 'files');
const dest = path.resolve('web/assets/fonts');
await mkdir(dest, { recursive: true });
for (const w of [400, 500, 600, 700]) {
  await copyFile(path.join(src, `montserrat-latin-${w}-normal.woff2`), path.join(dest, `montserrat-latin-${w}-normal.woff2`));
}
await copyFile(path.join(pkgDir, 'LICENSE'), path.join(dest, 'LICENSE-Montserrat.txt'));
console.log('[fonts] copied to web/assets/fonts');
