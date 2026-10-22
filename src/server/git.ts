// Local version control through the installed git command line.
import { execFile } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';

export class GitError extends Error {
  constructor(
    readonly code: 'GIT_MISSING' | 'NOT_REPO' | 'GIT_FAILED',
    message: string
  ) {
    super(message);
  }
}

function git(cwd: string, args: string[], maxBuffer = 8 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    // windowsHide: no flashing console window on Windows. core.quotepath=false returns
    // non-ASCII file names unchanged.
    execFile('git', ['-c', 'core.quotepath=false', ...args], { cwd, maxBuffer, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } }, (err, stdout, stderr) => {
      if (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === 'ENOENT') return reject(new GitError('GIT_MISSING', 'Git is not installed or not in the PATH.'));
        return reject(new GitError('GIT_FAILED', (stderr || e.message).trim().split('\n').slice(-3).join(' ')));
      }
      resolve(stdout);
    });
  });
}

/**
 * Project path (/folder/file or folder/file, also with backslashes) as a Git pathspec relative
 * to the project. Git accepts forward slashes on Windows, so always ./folder/file.
 */
export function gitPath(p: string): string {
  const parts = String(p).replace(/\\/g, '/').split('/').filter((s) => s && s !== '.' && s !== '..');
  return parts.length ? './' + parts.join('/') : '.';
}

const author = () => ['-c', `user.name=${config().git.name}`, '-c', `user.email=${config().git.email}`];

export async function isRepo(root: string): Promise<boolean> {
  return existsSync(join(root, '.git'));
}

export async function init(root: string): Promise<void> {
  await git(root, ['init', '-b', 'main']).catch(async (e: GitError) => {
    if (e.code !== 'GIT_FAILED') throw e;
    await git(root, ['init']);
  });
  const gi = join(root, '.gitignore');
  if (!existsSync(gi)) writeFileSync(gi, '.opencraft/layout.json\n.opencraft/cache/\n.DS_Store\n');
}

export interface StatusEntry {
  path: string;
  index: string;
  work: string;
}

export async function status(root: string): Promise<{ branch: string; entries: StatusEntry[] }> {
  if (!(await isRepo(root))) throw new GitError('NOT_REPO', 'No repository. Create one first.');
  const out = await git(root, ['status', '--porcelain=v1', '-z', '-uall', '--branch']);
  const parts = out.split('\0').filter(Boolean);
  let branch = 'main';
  const entries: StatusEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p.startsWith('## ')) {
      branch = p.slice(3).replace(/^No commits yet on /, '').split('...')[0]!;
      continue;
    }
    const x = p[0]!;
    const y = p[1]!;
    entries.push({ path: '/' + p.slice(3), index: x, work: y });
    if (x === 'R' || x === 'C') i++; // skip the source path
  }
  return { branch, entries };
}

export async function add(root: string, paths: string[]): Promise<void> {
  await git(root, ['add', '-A', '--', ...(paths.length ? paths.map(gitPath) : ['.'])]);
}

export async function unstage(root: string, paths: string[]): Promise<void> {
  await git(root, ['reset', '-q', '--', ...paths.map(gitPath)]).catch(() => git(root, ['rm', '--cached', '-q', '-r', '--', ...paths.map(gitPath)]));
}

export async function commit(root: string, message: string, all = true): Promise<string> {
  if (!(await isRepo(root))) await init(root);
  if (all) await add(root, []);
  await git(root, [...author(), 'commit', '-q', '-m', message]);
  return (await git(root, ['rev-parse', 'HEAD'])).trim();
}

export interface LogEntry {
  sha: string;
  parents: string[];
  refs: string[];
  author: string;
  time: number;
  message: string;
}

export async function log(root: string, limit = 200, all = true): Promise<LogEntry[]> {
  if (!(await isRepo(root))) return [];
  const out = await git(root, ['log', ...(all ? ['--all'] : []), '--date-order', `-n${limit}`, '--format=%H%x1f%P%x1f%D%x1f%an%x1f%at%x1f%s%x1e']).catch((e: GitError) => {
    if (/does not have any commits|unknown revision/.test(e.message)) return '';
    throw e;
  });
  return out
    .split('\x1e')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [sha, parents, refs, a, t, s] = l.split('\x1f');
      return { sha: sha!, parents: parents ? parents.split(' ') : [], refs: refs ? refs.split(', ').filter(Boolean) : [], author: a!, time: Number(t) * 1000, message: s! };
    });
}

export async function branches(root: string): Promise<{ current: string; all: string[] }> {
  if (!(await isRepo(root))) return { current: 'main', all: [] };
  const out = await git(root, ['branch', '--format=%(HEAD)%(refname:short)']);
  const all: string[] = [];
  let current = 'main';
  for (const l of out.split('\n').filter(Boolean)) {
    const name = l.slice(1);
    all.push(name);
    if (l[0] === '*') current = name;
  }
  return { current, all };
}

export async function switchBranch(root: string, name: string, create = false): Promise<void> {
  if (!/^[\w./-]+$/.test(name)) throw new GitError('GIT_FAILED', 'Invalid branch name');
  await git(root, create ? ['switch', '-c', name] : ['switch', name]);
}

export async function diff(root: string, path?: string): Promise<string> {
  if (!(await isRepo(root))) return '';
  const args = ['diff', 'HEAD', '--no-color', '--no-ext-diff'];
  const out = await git(root, path ? [...args, '--', gitPath(path)] : args).catch(() => git(root, path ? ['diff', '--no-color', '--', gitPath(path)] : ['diff', '--no-color']));
  return out.slice(0, 200_000);
}

export async function show(root: string, sha: string): Promise<string> {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new GitError('GIT_FAILED', 'Invalid commit ID');
  return (await git(root, ['show', '--no-color', '--stat', '--patch', '--format=%H%n%an <%ae>%n%at%n%n%B', sha])).slice(0, 200_000);
}
