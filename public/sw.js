// OpenCraft service worker: offline use of the IDE workspace after the first load.
//
// - Workspace (HTML, JS, CSS, logos, sounds): network first, from the cache when there is no
//   connection. The build writes precache.json with every file of the workspace.
// - Apps under apps/<app>/ (WebAssembly, 40 MB per app): cache first, because the file names
//   carry a content hash. Each app is stored when it is first opened. The message
//   {type: 'cache-apps'} loads all four apps ahead of time.
// - Requests to other origins and to /api, /mcp and /ws (local backend) never use the cache.

// Bump VERSION when the workspace changes in a way old caches must not survive, and APPS with every
// app release (public/releases.json): activate deletes every cache with another name, so the old
// WebAssembly binaries leave the device at once. apps-v2: WordCraft, GridCraft, DeckCraft 0.9.0, PdfCraft 0.10.1.
const VERSION = 'opencraft-ide-v5';
const SHELL = `${VERSION}-shell`;
const APPS = 'opencraft-apps-v2';
const APP_IDS = ['wordcraft', 'gridcraft', 'deckcraft', 'pdfcraft'];
const BASE = new URL('./', self.location).href;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      let list = ['./ide/', './site.webmanifest', './favicon.svg'];
      try {
        const res = await fetch('./precache.json', { cache: 'no-store' });
        if (res.ok) list = [...new Set([...list, ...(await res.json()).files])];
      } catch {
        /* development mode: no precache.json, files are stored as they load */
      }
      let count = 0;
      await Promise.all(
        list.map(async (url) => {
          try {
            const res = await fetch(url, { cache: 'no-cache' });
            if (res.ok) {
              await cache.put(url, res);
              count++;
            }
          } catch {
            /* a single file is missing */
          }
        })
      );
      self.precached = count;
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== SHELL && key !== APPS) await caches.delete(key);
      await self.clients.claim();
      for (const c of await self.clients.matchAll()) c.postMessage({ type: 'precached', count: self.precached || 0 });
    })()
  );
});

const isApp = (url) => url.href.startsWith(BASE + 'apps/');
const immutable = (url) => /-[0-9a-f]{16}(_bg)?\.(wasm|js|ico|png)$/.test(url.pathname);

async function networkFirst(req) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') cache.put(req, res.clone());
    return res;
  } catch (e) {
    const hit = (await cache.match(req, { ignoreSearch: req.mode === 'navigate' })) || (req.mode === 'navigate' ? await cache.match('./ide/') : null);
    if (hit) return hit;
    throw e;
  }
}

async function appFirst(req, url) {
  const cache = await caches.open(APPS);
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit && immutable(url)) return hit;
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    if (hit) return hit;
    throw e;
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/@vite') || url.pathname.includes('/@fs/') || url.searchParams.has('import')) return; // Vite development
  // Local backend: project data, AI streams, MCP and WebSocket never come from the cache
  if (/^\/(api|mcp|ws)(\/|$)/.test(url.pathname)) return;
  event.respondWith(isApp(url) ? appFirst(req, url) : networkFirst(req));
});

/** Loads every file of the four apps into the cache. */
async function cacheApps(port) {
  const cache = await caches.open(APPS);
  const files = [];
  for (const id of APP_IDS) {
    const base = `${BASE}apps/${id}/`;
    try {
      const html = await (await fetch(base)).text();
      files.push(base, base + 'index.html');
      for (const m of html.matchAll(/(?:src|href)=["']\.\/([^"'?#]+)["']|from ["']\.\/([^"']+)["']|module_or_path:\s*["']\.\/([^"']+)["']/g)) {
        files.push(base + (m[1] || m[2] || m[3]));
      }
    } catch {
      /* app not reachable */
    }
  }
  const unique = [...new Set(files)];
  let done = 0;
  let bytes = 0;
  let failed = 0;
  for (const url of unique) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(res.status);
      const blob = await res.clone().blob();
      bytes += blob.size;
      await cache.put(url, res);
    } catch {
      failed++;
    }
    done++;
    port?.postMessage({ type: 'progress', done, total: unique.length, bytes });
  }
  port?.postMessage({ type: 'done', files: done - failed, failed, bytes });
}

self.addEventListener('message', (event) => {
  if (event.data?.type === 'cache-apps') event.waitUntil(cacheApps(event.ports[0]));
});
