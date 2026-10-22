#!/usr/bin/env node
// Starts the backend (Hono, port 5176) and Vite (port 5175) together.
// Vite forwards /api, /mcp and /ws to the backend.
import { spawn } from 'node:child_process';

const PORT = process.env.OPENCRAFT_PORT || '5176';
const UI_PORT = process.env.OPENCRAFT_UI_PORT || '5175';
const LAN = process.env.OPENCRAFT_LAN === '1' || process.argv.includes('--lan');
const env = { ...process.env, OPENCRAFT_DEV: '1', OPENCRAFT_PORT: PORT, OPENCRAFT_UI_PORT: UI_PORT, ...(LAN ? { OPENCRAFT_LAN: '1' } : {}) };
const procs = [
  // Restart only when code in src/ changes. Watching every imported module also restarted the
  // backend on unrelated file events on Windows (for example in the temp folder).
  spawn(process.execPath, ['--import', 'tsx', '--watch-path=src', '--watch-preserve-output', 'src/server/index.ts'], { env, stdio: 'inherit' }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', LAN ? '0.0.0.0' : '127.0.0.1', '--port', UI_PORT, '--strictPort'], { env, stdio: 'inherit' }),
];
const stop = () => {
  for (const p of procs) p.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', (code) => code && stop());
console.log(`\nOpenCraft: http://localhost:${UI_PORT}/ide/${LAN ? '  (home network mode: the pairing address is in the backend output above)' : ''}\n`);
