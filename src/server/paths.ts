// Folders and safe path resolution of the local backend.
// Works on Windows (backslashes, drive letters, letter case),
// macOS and Linux. The path functions take the path module as a parameter, so the
// Windows rules can be tested on Linux too (tests/server/windows.test.ts).
import { homedir } from 'node:os';
import nodePath from 'node:path';
import { mkdirSync } from 'node:fs';

export type PathModule = typeof nodePath.posix;

export const IS_WIN = process.platform === 'win32';
export const HOME = nodePath.resolve(process.env.OPENCRAFT_HOME || nodePath.join(homedir(), 'OpenCraft'));
export const PROJECTS_DIR = nodePath.join(HOME, 'projects');
export const TRASH_DIR = nodePath.join(HOME, '.trash');
export const CONFIG_FILE = nodePath.join(HOME, 'config.json');
export const META_DIR = '.opencraft';

for (const d of [HOME, PROJECTS_DIR, TRASH_DIR]) mkdirSync(d, { recursive: true });

export class PathError extends Error {
  readonly code = 'PATH_INVALID';
}

/** Device names reserved on Windows (also with an extension, for example nul.txt). */
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i;

/** Checks single path segments for patterns that are dangerous or invalid on Windows. */
export function windowsSegmentProblem(seg: string): string | null {
  if (seg.includes(':')) return 'colon (drive or alternate data stream)';
  if (RESERVED.test(seg)) return 'reserved device name';
  if (seg !== '.' && seg !== '..' && /[. ]$/.test(seg)) return 'dot or space at the end';
  if (/[<>"|?*\x00-\x1f]/.test(seg)) return 'character not allowed';
  return null;
}

/** Turns a project path (/folder/file.xlsx) into an absolute path inside the project. */
export function resolveIn(root: string, projectPath: string, P: PathModule = nodePath, win = IS_WIN): string {
  const clean = ('/' + String(projectPath || '/')).replace(/\\/g, '/').replace(/\/+/g, '/');
  if (win) {
    for (const seg of clean.split('/')) {
      const problem = seg && windowsSegmentProblem(seg);
      if (problem) throw new PathError(`Path not allowed (${problem}): ${projectPath}`);
    }
  }
  const base = P.resolve(root);
  const abs = P.resolve(base, '.' + clean);
  // Windows: letter case does not matter
  const a = win ? abs.toLowerCase() : abs;
  const b = win ? base.toLowerCase() : base;
  if (a !== b && !a.startsWith(b.endsWith(P.sep) ? b : b + P.sep)) throw new PathError(`Path outside the project: ${projectPath}`);
  return abs;
}

/** Absolute path back to project notation (/folder/file), always with forward slashes. */
export function toProjectPath(root: string, abs: string, P: PathModule = nodePath): string {
  const rel = P.relative(root, abs);
  return '/' + rel.split(P.sep).join('/').replace(/\\/g, '/');
}

export function normProjectPath(p: string): string {
  const parts: string[] = [];
  for (const seg of String(p).replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return '/' + parts.join('/');
}

/** Key for comparing project paths (Windows file systems ignore letter case). */
export const pathKey = (p: string, win = IS_WIN): string => (win ? p.toLowerCase() : p);

/**
 * Checks an entry of a ZIP archive (protection against Zip Slip).
 * Returns the relative path with forward slashes, or null when the entry would lead out of the
 * project: absolute paths, drive letters, UNC paths, "..", colons.
 */
export function safeZipEntry(name: string): string | null {
  const n = String(name).replace(/\\/g, '/');
  if (/^[a-zA-Z]:/.test(n) || n.startsWith('//')) return null;
  const segs = n.split('/').filter((s) => s && s !== '.');
  if (!segs.length) return null;
  for (const s of segs) if (s === '..' || windowsSegmentProblem(s)) return null;
  return segs.join('/');
}
