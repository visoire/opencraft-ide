// The app releases the site serves, shared by the build (copy-apps.mjs), the Vite dev server,
// the homepage placeholders (vite.config.js) and the clean redirects (redirects.mjs).
//   apps/<app>/          the hosted web build (Open buttons, workspace)
//   downloads/<zip>      the web build zip (Download section)
// The data lives in public/releases.json (also read by go.php and the IDE registry).
// Source folder: <set>/web/<app>-web-<ver>/ and <set>/zip-web/<app>-web-<ver>.zip, the web zip
// repacked by scripts/pack-web-zips.ps1 with a one-click launcher, because the original zip only
// works behind a web server and opens to a blank "Loading…" page when index.html is double-clicked.
// The Windows portable builds (x64, x86, ARM64, about 17 to 96 MB each) are linked from the
// GitHub release of each app instead of being hosted here.
// When a new version lands: add its folder under versions/, update releases.json, run the pack
// script, then `npm run build`.
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MANIFEST = fileURLToPath(new URL('../public/releases.json', import.meta.url));

/** @type {{ set: string, appsCache: string, apps: { app: string, name: string, version: string, tag: string, date: string, web: string, webVersion?: string, webNote?: string, webZipBytes: number, windows: Record<'x64'|'x86'|'arm64', { file: string, bytes: number }> }[] }} */
export const MANIFEST_DATA = JSON.parse(readFileSync(MANIFEST, 'utf8'));

export const SRC = MANIFEST_DATA.set;
export const RELEASES = MANIFEST_DATA.apps;
export const ARCHES = /** @type {const} */ (['x64', 'x86', 'arm64']);
export const ARCH_LABEL = { x64: '64-bit', x86: '32-bit', arm64: 'ARM64' };

/** The version that runs in the browser (apps/<app>/, IDE panel, web zip). Usually the release itself. */
export const webVersion = (r) => r.webVersion || r.version;

/** Size as shown on the site: MiB with one decimal, like GitHub's release page ("95.5 MB"). */
export const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

/** Where a download file comes from: the repacked web zip when it exists, else the original. */
export function zipSource(name) {
  const fixed = join(SRC, 'zip-web', name);
  if (existsSync(fixed)) return fixed;
  return join(SRC, 'zip', name);
}

export const downloadNames = (r) => [`${r.web}.zip`];

/** Direct link to a Windows portable build on the app's GitHub release. */
export const windowsAsset = (r, arch) => `https://github.com/storytold/${r.app}/releases/download/${r.tag}/${r.windows[arch].file}`;

/**
 * Where an outdated or unknown download name should go instead (old links, bookmarks):
 *   <app>-web-<any version>.zip                       -> the current web zip
 *   <app>-<any version>-windows-<arch>-portable.zip   -> the current Windows build on GitHub
 * Returns { local: file name } or { url: absolute URL }, or null.
 */
export function downloadFallback(name) {
  const web = name.match(/^([a-z]+)-web-[\d.]+\.zip$/);
  const win = name.match(/^([a-z]+)-[\d.]+-windows-(x64|x86|arm64)-portable\.zip$/);
  const r = RELEASES.find((x) => x.app === (web || win)?.[1]);
  if (!r) return null;
  if (web) return { local: `${r.web}.zip` };
  return { url: windowsAsset(r, win[2]) };
}

/**
 * Homepage placeholders, filled at build time (vite.config.js):
 *   <!--REL:<app>:version-->   0.9.0
 *   <!--REL:<app>:meta-->      v0.9.0 · about 16 MB   (app card; "v0.9.0 · web 0.8.0 · …" when the
 *                              browser build is older than the release)
 *   <!--REL:<app>:date-->      2026-10-21
 *   <!--DOWNLOADS-->           the rows of the download table
 */
export function releasePlaceholders(html, goUrl, base = '') {
  const find = (id) => RELEASES.find((r) => r.app === id);
  return html
    .replace(/<!--REL:(\w+):(\w+)-->/g, (m, id, field) => {
      const r = find(id);
      if (!r) return m;
      if (field === 'meta') return `v${r.version}${webVersion(r) !== r.version ? ` · web ${webVersion(r)}` : ''} · about ${Math.round(r.webZipBytes / 1048576)} MB`;
      if (field === 'webzip') return `${r.web}.zip`;
      return String(r[field] ?? m);
    })
    .replace(/<!--DOWNLOADS-->/g, () => RELEASES.map((r) => downloadRow(r, goUrl, base)).join('\n'));
}

function downloadRow(r, goUrl, base) {
  const win = ARCHES.map((a) => `<a class="dl-win" href="${goUrl(base, r.app, `win-${a}`)}" rel="noopener" data-size="${r.windows[a].bytes}"><span>${ARCH_LABEL[a]}</span><em>${mb(r.windows[a].bytes)}</em></a>`).join('');
  return `        <div class="dl-row">
          <span class="dl-app"><img src="./assets/logos/${r.app}.webp" width="28" height="28" alt="" loading="lazy" decoding="async"><b>${r.name}</b><em>v${r.version} · alpha <span class="dl-date">· ${r.date}</span></em></span>
          <div class="dl-wins" role="group" aria-label="${r.name} for Windows, portable zip">${win}</div>
          <a class="dl-file" href="./downloads/${r.web}.zip" download data-size="${r.webZipBytes}"${r.webNote ? ` title="${r.webNote.replace(/"/g, '&quot;')}"` : ''}><span>${webVersion(r) !== r.version ? `Web ${webVersion(r)}` : 'Web'}</span><em>${mb(r.webZipBytes)} zip</em></a>
          <a class="dl-more" href="${goUrl(base, r.app, 'releases')}" target="_blank" rel="noopener">Installers, macOS, Linux <span aria-hidden="true">↗</span></a>
        </div>`;
}

/** Script for iPadOS, Retina and embedded panels (public/craft-frame.js). It runs before the wasm module. */
export const SHIM_TAG = '<script src="../../craft-frame.js" data-opencraft-shim></script>';

/** Light and dark mode for the apps (public/craft-theme.js). Replaces the release's craft-theme-sync.js. */
export const THEME_TAG = '<script src="../../craft-theme.js" data-opencraft-theme></script>';

/**
 * Adds the shim to an app's index.html once: after the viewport meta (which it rewrites), else after <head>.
 * Also swaps the release's theme script for OpenCraft's, which never writes the theme back.
 * Releases from 0.9 on ship without craft-theme-sync.js; the theme script then goes before </head>.
 */
export function injectShim(html) {
  if (!html.includes('data-opencraft-theme')) {
    const sync = /<script[^>]+src=["']\.?\/?craft-theme-sync\.js["'][^>]*><\/script>/i;
    html = sync.test(html) ? html.replace(sync, THEME_TAG) : html.replace(/<\/head>/i, `  ${THEME_TAG}\n</head>`);
  }
  if (html.includes('data-opencraft-shim')) return html;
  const vp = /<meta[^>]+name=["']viewport["'][^>]*>/i;
  if (vp.test(html)) return html.replace(vp, (m) => `${m}\n  ${SHIM_TAG}`);
  return html.replace(/<head([^>]*)>/i, (m) => `${m}\n  ${SHIM_TAG}`);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.wasm': 'application/wasm', '.ico': 'image/x-icon',
  '.png': 'image/png', '.json': 'application/json', '.md': 'text/plain; charset=utf-8', '.zip': 'application/zip',
};

/** Vite plugin: serves apps/<app>/ and downloads/<zip> straight from versions/ during `npm run dev`. */
export function releaseFiles() {
  const root = resolve('.');
  const handle = (req, res, next) => {
    const path = decodeURIComponent(new URL(req.url, 'http://local').pathname);
    let file = null;
    const app = path.match(/\/apps\/([a-z]+)(\/.*)?$/);
    const dl = path.match(/\/downloads\/([\w.-]+\.zip)$/);
    if (app) {
      const r = RELEASES.find((x) => x.app === app[1]);
      if (!r) return next();
      if (!app[2]) { res.statusCode = 301; res.setHeader('Location', req.url.replace(/(\?|$)/, '/$1')); return res.end(); }
      const base = resolve(SRC, 'web', r.web);
      file = normalize(join(base, app[2] === '/' ? 'index.html' : app[2]));
      if (!file.startsWith(base)) file = null;
    } else if (dl) {
      const r = RELEASES.find((x) => downloadNames(x).includes(dl[1]));
      if (r) file = resolve(root, zipSource(dl[1]));
      else {
        // Outdated name (an old version): same redirect as the Apache rule in .htaccess
        const to = downloadFallback(dl[1]);
        if (!to) return next();
        res.statusCode = 302;
        res.setHeader('Location', to.url || path.replace(/[^/]+$/, to.local));
        return res.end();
      }
    } else return next();
    if (!file || !existsSync(file) || !statSync(file).isFile()) return next();
    if (app && file.endsWith('index.html')) {
      const html = injectShim(readFileSync(file, 'utf8'));
      res.setHeader('Content-Type', TYPES['.html']);
      res.setHeader('Cache-Control', 'no-cache');
      return res.end(html);
    }
    res.setHeader('Content-Type', TYPES[extname(file)] || 'application/octet-stream');
    res.setHeader('Content-Length', statSync(file).size);
    if (dl) res.setHeader('Content-Disposition', `attachment; filename="${dl[1]}"`);
    createReadStream(file).pipe(res);
  };
  return {
    name: 'opencraft-release-files',
    configureServer(server) { server.middlewares.use(handle); },
    configurePreviewServer(server) { server.middlewares.use(handle); },
  };
}
