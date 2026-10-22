// After `vite build`: copies the four web builds into dist/apps/<app>/ and the web zips into
// dist/downloads/, so the Open buttons, the workspace and the download links work from the same
// host. The release list and sources live in public/releases.json (read via scripts/releases.mjs).
// The Windows portable builds are linked from GitHub (go/<app>/win-<arch>), not copied.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RELEASES, SRC, downloadNames, zipSource, injectShim, mb, webVersion } from './releases.mjs';
import { patchApps } from './patch-apps.mjs';

const OUT = 'dist';
let missing = 0;
let problems = 0;

// Startup fixes listed in releases.json (idempotent; refuses a build whose bytes do not match)
for (const x of patchApps()) {
  console.log(`patch ${x.state}: ${x.app} ${x.detail}`);
  if (x.state === 'error') problems++;
}

/** Upstream trademark assets (docs/brand/) must never be served. */
const hasBrand = (dir) => readdirSync(dir, { withFileTypes: true }).some((d) => d.isDirectory() && (d.name === 'brand' || hasBrand(join(dir, d.name))));

for (const r of RELEASES) {
  const web = join(SRC, 'web', r.web);
  if (existsSync(web)) {
    if (hasBrand(web)) {
      console.error(`refused: ${web} contains a brand/ folder (trademark assets). Remove it from the web build.`);
      problems++;
      continue;
    }
    cpSync(web, join(OUT, 'apps', r.app), { recursive: true });
    // iPadOS, Retina and embedded panels: public/craft-frame.js runs before the wasm module
    const index = join(OUT, 'apps', r.app, 'index.html');
    if (existsSync(index)) writeFileSync(index, injectShim(readFileSync(index, 'utf8')));
    console.log(`apps/${r.app}/  <- ${web}  (v${webVersion(r)}${webVersion(r) !== r.version ? `, release ${r.version}: ${r.webNote || 'older browser build'}` : ''})`);
  } else {
    console.warn(`missing web build: ${web}`);
    missing++;
  }
  for (const name of downloadNames(r)) {
    const file = zipSource(name);
    if (!existsSync(file)) { console.warn(`missing zip: ${file}`); missing++; continue; }
    const size = statSync(file).size;
    if (size !== r.webZipBytes) {
      console.warn(`size mismatch: ${file} is ${size} bytes, releases.json says ${r.webZipBytes}. Run scripts/pack-web-zips.ps1 again.`);
      problems++;
    }
    mkdirSync(join(OUT, 'downloads'), { recursive: true });
    cpSync(file, join(OUT, 'downloads', name));
    console.log(`downloads/${name}  (${mb(size)}, ${file})`);
  }
}

if (missing) {
  console.warn(`${missing} release file(s) missing. The page links to them anyway; add the files or fix public/releases.json.`);
}
if (problems) process.exit(1);
