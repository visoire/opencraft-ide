#!/usr/bin/env node
// Startup fixes for app web builds, applied to <set>/web/<build>/ in place before packing and
// building. The patches are listed per app in public/releases.json ("patches"); the script is
// idempotent and refuses to touch a build whose bytes do not match what a patch expects.
//
// Kind "oncelock-instance-id" (DeckCraft, storytold/deckcraft#959):
//   instance_id() in crates/engine/src/recovery.rs fills a OnceLock<u64> with a hash that includes
//   std::process::id(). On wasm32-unknown-unknown that call panics ("no pids on this platform"),
//   so the web build stops at startup. The patch writes a random id (low 24 bits clear, below 2^53,
//   the same rules the source enforces) and the OnceLock state COMPLETE (3) into the module's memory
//   right before __wbindgen_start(), so the initialiser never runs. The wasm itself stays unchanged.
//   "id" and "state" are the memory addresses of the OnceLock value and its state byte; the script
//   checks them against the code of the wasm (state load, compare with 3, then the id address).
//   After editing the glue it updates the integrity hash of the modulepreload link in index.html.
//
// Usage: node scripts/patch-apps.mjs [--check]   (--check: report only, exit 1 when a patch is missing)
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELEASES, SRC } from './releases.mjs';

const MARK = 'opencraft-patch:oncelock-instance-id';

const sleb = (v) => {
  const out = [];
  let more = true;
  while (more) {
    let b = v & 0x7f;
    v >>= 7;
    if ((v === 0 && !(b & 0x40)) || (v === -1 && (b & 0x40))) more = false;
    else b |= 0x80;
    out.push(b);
  }
  return out;
};

/** Byte pattern of the OnceLock fast path: i32.const state; i32.load8_u; i32.const 3; i32.ne; if; local.get 0; i32.const id */
export function onceLockPattern(id, state) {
  return Buffer.from([0x41, ...sleb(state), 0x2d, 0x00, 0x00, 0x41, 0x03, 0x47, 0x04, 0x40, 0x20, 0x00, 0x41, ...sleb(id)]);
}

function glueSnippet(p) {
  return `    // ${MARK} (${p.issue}): instance_id() calls std::process::id(), which panics on
    // wasm32-unknown-unknown. Pre-fill its OnceLock with a random id (low 24 bits clear, below 2^53)
    // and the state COMPLETE, so the initialiser never runs. Added by OpenCraft (scripts/patch-apps.mjs).
    try {
        if (instance.exports && instance.exports.memory) {
            const id = BigInt(1 + Math.floor(Math.random() * 0x1ffffffe)) << 24n;
            new DataView(instance.exports.memory.buffer).setBigUint64(${p.id}, id, true);
            new Uint8Array(instance.exports.memory.buffer)[${p.state}] = 3;
        }
    } catch (_) {}
`;
}

const sri = (text) => 'sha384-' + createHash('sha384').update(text).digest('base64');

/** Applies (or with check=true only verifies) every patch. Returns a list of { app, state, detail }. */
export function patchApps({ check = false } = {}) {
  const report = [];
  for (const r of RELEASES) {
    for (const p of r.patches || []) {
      const dir = join(SRC, 'web', r.web);
      const gluePath = join(dir, p.glue);
      const wasmPath = join(dir, p.glue.replace(/\.js$/, '_bg.wasm'));
      const indexPath = join(dir, 'index.html');
      if (p.kind !== 'oncelock-instance-id') { report.push({ app: r.app, state: 'error', detail: `unknown patch kind ${p.kind}` }); continue; }
      if (![gluePath, wasmPath, indexPath].every(existsSync)) { report.push({ app: r.app, state: 'error', detail: `missing files in ${dir}` }); continue; }
      const wasm = readFileSync(wasmPath);
      const hits = [];
      const pat = onceLockPattern(p.id, p.state);
      for (let i = wasm.indexOf(pat); i >= 0; i = wasm.indexOf(pat, i + 1)) hits.push(i);
      if (hits.length !== 1 || !wasm.includes(Buffer.from('no pids on this platform'))) {
        report.push({ app: r.app, state: 'error', detail: `the wasm does not match the patch (${hits.length} matches of the OnceLock pattern for id ${p.id}, state ${p.state}); find the new addresses before shipping this build` });
        continue;
      }
      let glue = readFileSync(gluePath, 'utf8');
      let index = readFileSync(indexPath, 'utf8');
      const applied = glue.includes(MARK);
      if (!applied) {
        if (check) { report.push({ app: r.app, state: 'missing', detail: `${gluePath} is not patched` }); continue; }
        const anchor = /\n(\s*)wasm\.__wbindgen_start\(\);/;
        if (!anchor.test(glue)) { report.push({ app: r.app, state: 'error', detail: 'no wasm.__wbindgen_start() in the glue' }); continue; }
        glue = glue.replace(anchor, (m) => `\n${glueSnippet(p)}${m.slice(1)}`);
        writeFileSync(gluePath, glue);
      }
      // The modulepreload link carries the glue's integrity hash: keep it in step with the file
      const link = new RegExp(`(<link[^>]+href="\\./${p.glue.replace(/[.]/g, '\\.')}"[^>]*integrity=")([^"]+)(")`);
      const want = sri(glue);
      const m = index.match(link);
      if (!m) { report.push({ app: r.app, state: 'error', detail: 'no modulepreload link with integrity for the glue in index.html' }); continue; }
      if (m[2] !== want) {
        if (check) { report.push({ app: r.app, state: 'missing', detail: 'integrity in index.html does not match the glue' }); continue; }
        index = index.replace(link, `$1${want}$3`);
        writeFileSync(indexPath, index);
      }
      report.push({ app: r.app, state: applied && m[2] === want ? 'ok' : 'patched', detail: `${p.glue}: OnceLock at ${p.id}/${p.state} (${p.issue})` });
    }
  }
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const check = process.argv.includes('--check');
  const report = patchApps({ check });
  for (const x of report) console.log(`${x.state.padEnd(8)} ${x.app}: ${x.detail}`);
  if (!report.length) console.log('no app patches listed in releases.json');
  if (report.some((x) => x.state === 'error' || x.state === 'missing')) process.exit(1);
}
