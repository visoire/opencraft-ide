// Team Mode: a Team Leader model plans, specialist sub-agents work in parallel, the leader reviews.
//
//   Stage 1  Plan     the leader turns the prompt into a task graph (JSON DAG: id, title,
//                     assignedAgent, dependencies, targetFiles, instructions)
//   Stage 2  Work     every task whose dependencies are done starts at once, up to the concurrency
//                     limit, each in its own sub-thread with its own model and a tool scope
//   Stage 3  Review   each finished task is checked (failed MCP calls, empty output) and reviewed by
//                     the leader; a rejected task gets a targeted retry instruction, then the leader
//                     writes the final answer
//
// No DOM here: roles, presets, the configuration schema, the task graph parser and the scheduler are
// shared by the interface (src/chat/team-runner.ts), the backend (config) and the tests. The model
// calls come in through a TeamDriver.

import { z } from 'zod';
import { repairJson } from '../core/json-repair.js';
import { addRoleUsage, type RoleUsage } from './usage.js';
import type { TokenUsage } from './types.js';

// ---------------------------------------------------------------- Roles

export type WorkerRoleId = 'grid' | 'word' | 'deck' | 'pdf' | 'dev';
export type TeamRoleId = 'leader' | WorkerRoleId;
export const WORKER_ROLES: WorkerRoleId[] = ['grid', 'word', 'deck', 'pdf', 'dev'];
export const TEAM_ROLES: TeamRoleId[] = ['leader', ...WORKER_ROLES];

export interface RoleDef {
  id: TeamRoleId;
  /** @ mention without the @ */
  mention: string;
  name: string;
  /** Short label for badges */
  short: string;
  /** App whose mark the card shows (workspace: the leader, code: the dev worker) */
  app: 'workspace' | 'gridcraft' | 'wordcraft' | 'deckcraft' | 'pdfcraft' | 'code';
  /** Atelier accent */
  accent: string;
  /** Icon from src/app/icons.js */
  icon: string;
  scope: string;
  /** Tool apps (ToolMeta.app) the role may call */
  apps: string[];
}

export const ROLE_DEFS: Record<TeamRoleId, RoleDef> = {
  leader: { id: 'leader', mention: 'leader', name: 'Team Leader', short: 'Leader', app: 'workspace', accent: '#335CFF', icon: 'users', scope: 'Plans the work, assigns tasks, reviews every result and writes the final answer.', apps: [] },
  grid: { id: 'grid', mention: 'grid-agent', name: 'Data & Sheet Specialist', short: 'GridCraft', app: 'gridcraft', accent: '#10B981', icon: 'grid', scope: 'Spreadsheets: reading sheets, evaluating formulas, CSV and XLSX analysis, data modeling.', apps: ['gridcraft'] },
  word: { id: 'word', mention: 'word-agent', name: 'Document & Copy Specialist', short: 'WordCraft', app: 'wordcraft', accent: '#3B82F6', icon: 'file', scope: 'Documents: drafting reports, .docx and .md formatting, editing text.', apps: ['wordcraft'] },
  deck: { id: 'deck', mention: 'deck-agent', name: 'Presentation Specialist', short: 'DeckCraft', app: 'deckcraft', accent: '#F97316', icon: 'layers', scope: 'Presentations: slide layout, visual storytelling, charts, .pptx generation.', apps: ['deckcraft'] },
  pdf: { id: 'pdf', mention: 'pdf-agent', name: 'PDF & Compliance Specialist', short: 'PdfCraft', app: 'pdfcraft', accent: '#14B8A6', icon: 'shield', scope: 'PDF: extraction, verification, redaction review and signing.', apps: ['pdfcraft'] },
  dev: { id: 'dev', mention: 'dev-agent', name: 'Code & System Specialist', short: 'Dev', app: 'code', accent: '#335CFF', icon: 'terminal', scope: 'Code editing, terminal commands and Git operations.', apps: ['code', 'terminal', 'git', 'project'] },
};

/** Read-only project tools every specialist may use to find files. */
export const SHARED_TOOLS = ['list-files', 'search-files', 'search-project', 'panel-status'];

/** May this role call the tool? Specialists get their app's tools plus the shared read tools. */
export function toolAllowed(role: TeamRoleId, tool: { name: string; app: string; source?: string }): boolean {
  if (role === 'leader') return false;
  if (SHARED_TOOLS.includes(tool.name)) return true;
  // External MCP servers belong to the Code & System Specialist
  if (tool.source === 'external') return role === 'dev';
  return ROLE_DEFS[role].apps.includes(tool.app);
}

/** Role from what a model or a user wrote: "grid-agent", "@grid-agent", "GridCraft", "Data & Sheet Specialist", "grid". */
export function roleFromName(name: unknown): TeamRoleId | null {
  if (typeof name !== 'string') return null;
  const s = name.trim().replace(/^@/, '').toLowerCase();
  if (!s) return null;
  for (const r of TEAM_ROLES) {
    const d = ROLE_DEFS[r];
    if (s === r || s === d.mention || s === d.short.toLowerCase() || s === d.name.toLowerCase() || s === d.app) return r;
  }
  if (/sheet|grid|data|excel|xlsx|csv/.test(s)) return 'grid';
  if (/word|doc|copy|report|writer/.test(s)) return 'word';
  if (/deck|slide|present|pptx/.test(s)) return 'deck';
  if (/pdf|complian|sign|redact/.test(s)) return 'pdf';
  if (/dev|code|terminal|git|system|shell/.test(s)) return 'dev';
  if (/lead|orchestr/.test(s)) return 'leader';
  return null;
}

// ---------------------------------------------------------------- Configuration

export const EFFORT_CHOICES = ['auto', 'off', 'low', 'medium', 'high', 'max'] as const;
export type TeamEffort = (typeof EFFORT_CHOICES)[number];

export const TeamMemberSchema = z.object({
  role: z.enum(TEAM_ROLES as [TeamRoleId, ...TeamRoleId[]]),
  enabled: z.boolean().default(true),
  /** Provider id; empty: the chat's provider */
  provider: z.string().max(80).default(''),
  /** Model override; empty: the provider's model */
  model: z.string().max(120).default(''),
  effort: z.enum(EFFORT_CHOICES).default('auto'),
});
export type TeamMember = z.infer<typeof TeamMemberSchema>;

export const TeamConfigSchema = z.object({
  id: z.string().regex(/^[\w-]{1,40}$/).default('custom'),
  name: z.string().min(1).max(60).default('Custom team'),
  leader: TeamMemberSchema,
  workers: z.array(TeamMemberSchema).max(8),
  /** Sub-agents running at the same time */
  concurrency: z.number().int().min(1).max(6).default(3),
  /** leader: the leader model reviews every result; checks: only the automatic checks */
  review: z.enum(['leader', 'checks']).default('leader'),
  /** Retries the leader may order per task */
  maxRetries: z.number().int().min(0).max(3).default(1),
});
export type TeamConfig = z.infer<typeof TeamConfigSchema>;

export const TeamSettingsSchema = z.object({
  active: TeamConfigSchema.optional(),
  /** Team configurations the user saved */
  saved: z.array(TeamConfigSchema).max(20).default([]),
});
export type TeamSettings = z.infer<typeof TeamSettingsSchema>;

const member = (role: TeamRoleId, enabled = true, extra: Partial<TeamMember> = {}): TeamMember => ({ role, enabled, provider: '', model: '', effort: 'auto', ...extra });
const workers = (on: WorkerRoleId[], extra: Partial<TeamMember> = {}) => WORKER_ROLES.map((r) => member(r, on.includes(r), extra));

export interface TeamPreset extends TeamConfig {
  description: string;
}

export const TEAM_PRESETS: TeamPreset[] = [
  { id: 'studio', name: 'Full Studio Team', description: 'Every specialist, the leader reviews each result.', leader: member('leader', true, { effort: 'high' }), workers: workers(['grid', 'word', 'deck', 'pdf', 'dev']), concurrency: 3, review: 'leader', maxRetries: 1 },
  { id: 'executive-launch', name: 'Executive Launch Team', description: 'Figures from GridCraft, a report in WordCraft and slides in DeckCraft.', leader: member('leader', true, { effort: 'high' }), workers: workers(['grid', 'word', 'deck']), concurrency: 3, review: 'leader', maxRetries: 1 },
  { id: 'financial-audit', name: 'Financial Audit Team', description: 'Sheets, PDF verification and a written audit note.', leader: member('leader', true, { effort: 'max' }), workers: workers(['grid', 'pdf', 'word']), concurrency: 3, review: 'leader', maxRetries: 2 },
  { id: 'fullstack-dev', name: 'Fullstack Dev Team', description: 'Code, terminal and Git with documentation in WordCraft.', leader: member('leader', true, { effort: 'high' }), workers: workers(['dev', 'word']), concurrency: 2, review: 'leader', maxRetries: 1 },
  { id: 'hybrid-local', name: 'Fast Local/Hybrid Team', description: 'Cloud leader, fast local sub-agents on Ollama, automatic checks only.', leader: member('leader', true, { effort: 'medium' }), workers: workers(['grid', 'word', 'deck', 'pdf', 'dev'], { provider: 'ollama', effort: 'off' }), concurrency: 4, review: 'checks', maxRetries: 1 },
];

export const DEFAULT_TEAM: TeamConfig = structuredCloneSafe(TEAM_PRESETS[0]!);

function structuredCloneSafe<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

/** A complete configuration: every worker role exactly once, in the fixed order. */
export function normalizeTeam(input: unknown): TeamConfig {
  const parsed = TeamConfigSchema.safeParse(input);
  const base = parsed.success ? parsed.data : DEFAULT_TEAM;
  const byRole = new Map(base.workers.map((w) => [w.role, w]));
  const cleaned: TeamConfig = {
    ...base,
    leader: { ...base.leader, role: 'leader', enabled: true },
    workers: WORKER_ROLES.map((r) => ({ ...(byRole.get(r) || member(r, false)), role: r })),
  };
  // Without a single specialist the team cannot work: the defaults come back
  if (!cleaned.workers.some((w) => w.enabled)) cleaned.workers = structuredCloneSafe(DEFAULT_TEAM.workers);
  return cleaned;
}

export function presetById(id: string): TeamPreset | undefined {
  return TEAM_PRESETS.find((p) => p.id === id);
}

export const enabledWorkers = (cfg: TeamConfig, only?: WorkerRoleId[]): WorkerRoleId[] => cfg.workers.filter((w) => w.enabled && (!only || only.includes(w.role as WorkerRoleId))).map((w) => w.role as WorkerRoleId);

export const memberOf = (cfg: TeamConfig, role: TeamRoleId): TeamMember => (role === 'leader' ? cfg.leader : cfg.workers.find((w) => w.role === role) || member(role, false));

// ---------------------------------------------------------------- Task graph

export interface TaskNode {
  id: string;
  title: string;
  assignedAgent: WorkerRoleId;
  /** Task ids that must finish first */
  dependencies: string[];
  targetFiles: string[];
  instructions: string;
}

export interface TaskGraph {
  goal: string;
  tasks: TaskNode[];
}

export const MAX_TASKS = 10;

const RawTask = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  title: z.string().optional(),
  assignedAgent: z.unknown().optional(),
  agent: z.unknown().optional(),
  dependencies: z.array(z.union([z.string(), z.number()])).optional(),
  dependsOn: z.array(z.union([z.string(), z.number()])).optional(),
  targetFiles: z.array(z.string()).optional(),
  files: z.array(z.string()).optional(),
  instructions: z.string().optional(),
  description: z.string().optional(),
});

export interface ParsedGraph {
  graph: TaskGraph;
  /** Problems the model has to fix (unknown agents, cycles, missing tasks) */
  issues: string[];
  /** Notes on what the parser changed on its own (repaired JSON, dropped dependencies) */
  notes: string[];
  ok: boolean;
}

const normPath = (p: string) => '/' + p.trim().replace(/\\/g, '/').replace(/^@/, '').replace(/^\/+/, '');

/**
 * Reads the leader's plan. Accepts JSON in fences or with prose around it, {tasks: [...]} or a bare
 * array, and common key variants. Unknown or disabled agents and cycles are issues (the leader gets one
 * correction turn); with fallback: true they are repaired instead, so the run can always go on.
 */
export function parseTaskGraph(text: string, opt: { enabled: WorkerRoleId[]; fallback?: boolean }): ParsedGraph {
  const issues: string[] = [];
  const notes: string[] = [];
  const rep = repairJson(text);
  if (rep?.repaired) notes.push(...rep.notes);
  const v = rep?.value as { goal?: unknown; tasks?: unknown } | unknown[] | null | undefined;
  const list: unknown[] = Array.isArray(v) ? v : Array.isArray((v as { tasks?: unknown })?.tasks) ? ((v as { tasks: unknown[] }).tasks as unknown[]) : [];
  const goal = !Array.isArray(v) && typeof (v as { goal?: unknown })?.goal === 'string' ? String((v as { goal: string }).goal) : '';
  if (!rep) issues.push('The plan is not valid JSON. Answer with one JSON object {"goal": "...", "tasks": [...]}.');
  else if (!list.length) issues.push('The plan has no tasks. Give at least one task in "tasks".');
  if (list.length > MAX_TASKS) notes.push(`kept the first ${MAX_TASKS} of ${list.length} tasks`);

  const tasks: TaskNode[] = [];
  const seen = new Set<string>();
  list.slice(0, MAX_TASKS).forEach((raw, i) => {
    const r = RawTask.safeParse(raw);
    if (!r.success) return void issues.push(`Task ${i + 1} is not an object with id, title, assignedAgent, dependencies and targetFiles.`);
    const t = r.data;
    let id = String(t.id ?? `t${i + 1}`).trim().replace(/[^\w.-]/g, '-') || `t${i + 1}`;
    if (seen.has(id)) {
      notes.push(`renamed the duplicate task id ${id}`);
      id = `${id}-${i + 1}`;
    }
    seen.add(id);
    const rawAgent = t.assignedAgent ?? t.agent;
    let role = roleFromName(rawAgent);
    if (!role || role === 'leader') {
      issues.push(`Task ${id}: unknown agent ${JSON.stringify(rawAgent ?? null)}. Use one of: ${opt.enabled.map((x) => ROLE_DEFS[x].mention).join(', ')}.`);
      role = null;
    } else if (!opt.enabled.includes(role)) {
      issues.push(`Task ${id}: ${ROLE_DEFS[role].mention} is not on the team. Use one of: ${opt.enabled.map((x) => ROLE_DEFS[x].mention).join(', ')}.`);
    }
    const files = [...new Set([...(t.targetFiles || []), ...(t.files || [])].filter((f) => typeof f === 'string' && f.trim()).map(normPath))].slice(0, 12);
    tasks.push({
      id,
      title: (t.title || t.instructions || t.description || `Task ${i + 1}`).trim().slice(0, 160),
      assignedAgent: role || opt.enabled[0] || 'dev',
      dependencies: [...(t.dependencies || []), ...(t.dependsOn || [])].map((d) => String(d).trim()),
      targetFiles: files,
      instructions: (t.instructions || t.description || t.title || '').trim().slice(0, 6000),
    });
  });

  // Dependencies: known ids only, no self loops
  const ids = new Set(tasks.map((t) => t.id));
  for (const t of tasks) {
    const deps: string[] = [];
    for (const d of t.dependencies) {
      if (d === t.id) notes.push(`removed the self dependency of ${t.id}`);
      else if (!ids.has(d)) issues.push(`Task ${t.id} depends on ${d}, which is not in the plan.`);
      else if (!deps.includes(d)) deps.push(d);
    }
    t.dependencies = deps;
  }
  const cycle = findCycle(tasks);
  if (cycle) issues.push(`The dependencies form a cycle: ${cycle.join(' -> ')}. Dependencies must point to earlier work only.`);

  if (opt.fallback && issues.length) {
    // Repair instead of failing: disabled agents go to the first specialist on the team, dependencies
    // only point to earlier tasks (always acyclic), unknown dependencies were dropped above
    for (const t of tasks) if (!opt.enabled.includes(t.assignedAgent)) t.assignedAgent = opt.enabled[0] || t.assignedAgent;
    if (cycle) {
      const order = new Map(tasks.map((t, i) => [t.id, i]));
      for (const t of tasks) t.dependencies = t.dependencies.filter((d) => order.get(d)! < order.get(t.id)!);
    }
    notes.push(...issues.map((x) => `repaired: ${x}`));
    return { graph: { goal, tasks }, issues: [], notes, ok: tasks.length > 0 };
  }
  return { graph: { goal, tasks }, issues, notes, ok: !issues.length && tasks.length > 0 };
}

/** One cycle as a list of ids, or null. */
export function findCycle(tasks: Pick<TaskNode, 'id' | 'dependencies'>[]): string[] | null {
  const deps = new Map(tasks.map((t) => [t.id, t.dependencies]));
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    if (state.get(id) === 2) return null;
    if (state.get(id) === 1) return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 1);
    stack.push(id);
    for (const d of deps.get(id) || []) {
      const c = visit(d);
      if (c) return c;
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };
  for (const t of tasks) {
    const c = visit(t.id);
    if (c) return c;
  }
  return null;
}

/** Topological levels: level 0 has no dependencies, level n depends on levels below n. */
export function levels(tasks: Pick<TaskNode, 'id' | 'dependencies'>[]): string[][] {
  const level = new Map<string, number>();
  const deps = new Map(tasks.map((t) => [t.id, t.dependencies]));
  const of = (id: string, guard = 0): number => {
    if (level.has(id)) return level.get(id)!;
    if (guard > tasks.length) return 0;
    const l = Math.max(-1, ...(deps.get(id) || []).map((d) => of(d, guard + 1))) + 1;
    level.set(id, l);
    return l;
  };
  const out: string[][] = [];
  for (const t of tasks) (out[of(t.id)] ||= []).push(t.id);
  return out.filter(Boolean);
}

// ---------------------------------------------------------------- Prompts (model-facing, English)

const LANG_RULE = (de: boolean) => (de ? 'Write in German.' : 'Write in the language of the user (English by default).');

export function rosterLines(enabled: WorkerRoleId[]): string {
  return enabled.map((r) => `- ${ROLE_DEFS[r].mention}: ${ROLE_DEFS[r].name}. ${ROLE_DEFS[r].scope}`).join('\n');
}

export function planSystem(enabled: WorkerRoleId[], extra = ''): string {
  return [
    'You are the Team Leader of an OpenCraft AI team. OpenCraft is a local workspace with WordCraft (documents), GridCraft (spreadsheets), DeckCraft (presentations), PdfCraft (PDF), a code editor, a terminal and Git.',
    'You do not call tools yourself. You break the request into tasks for your specialist sub-agents.',
    'Answer with ONLY one JSON object, no prose, no Markdown:',
    '{"goal": "one sentence", "tasks": [{"id": "t1", "title": "short title", "assignedAgent": "grid-agent", "dependencies": [], "targetFiles": ["/sheets/budget.xlsx"], "instructions": "precise instructions"}]}',
    'Your specialists:',
    rosterLines(enabled),
    'Rules:',
    '1. assignedAgent is one of the mentions above. Give each task to the specialist whose tools fit.',
    '2. dependencies lists the ids of tasks that must finish first; their results are passed on. Tasks without open dependencies run at the same time, so only add a dependency when the task needs the other result.',
    '3. Two tasks that write the same file must depend on each other.',
    '4. targetFiles are project paths starting with / (read or written by the task). New files go into /documents, /sheets, /presentations, /pdf.',
    `5. At most ${MAX_TASKS} tasks, usually two to five. Instructions say exactly what to read, what to write and which figures to use.`,
    extra,
  ]
    .filter(Boolean)
    .join('\n');
}

export function reviewSystem(): string {
  return [
    'You are the Team Leader of an OpenCraft AI team reviewing the work of one specialist sub-agent.',
    'Check the result against the task goal. Failed tool calls, missing files and incomplete figures are reasons to reject.',
    'Answer with ONLY one JSON object: {"accept": true} or {"accept": false, "instruction": "targeted instruction for the retry: what is missing and how to fix it", "note": "one short sentence"}.',
  ].join('\n');
}

export function reviewInput(task: TaskNode, out: WorkerOutput, findings: string[]): string {
  const calls = out.toolCalls.map((c) => `- ${c.name}${c.path ? ` ${c.path}` : ''}: ${c.ok ? 'ok' : `failed: ${(c.text || '').slice(0, 300)}`}`).join('\n');
  return [
    `Task ${task.id} (${ROLE_DEFS[task.assignedAgent].mention}): ${task.title}`,
    `Instructions: ${task.instructions}`,
    task.targetFiles.length ? `Target files: ${task.targetFiles.join(', ')}` : '',
    `Tool calls:\n${calls || '- none'}`,
    out.changed.length ? `Files changed: ${out.changed.join(', ')}` : 'Files changed: none',
    findings.length ? `Automatic checks found:\n${findings.map((f) => `- ${f}`).join('\n')}` : 'Automatic checks: passed',
    `Report of the sub-agent:\n${out.text.slice(0, 6000) || '(empty)'}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function synthesisSystem(de: boolean): string {
  return [
    'You are the Team Leader of an OpenCraft AI team. Your specialists finished their tasks.',
    `Write the final answer to the user: what the team did, the key figures, and every file created or changed with its path. Mention tasks that failed. Short and to the point, two to eight lines. ${LANG_RULE(de)}`,
    'Do not invent results that are not in the reports.',
  ].join('\n');
}

export function synthesisInput(prompt: string, tasks: TaskState[]): string {
  return [
    `Request of the user:\n${prompt}`,
    ...tasks.map((t) => `Task ${t.id} (${ROLE_DEFS[t.assignedAgent].name}, ${t.status}${t.attempts > 1 ? `, ${t.attempts} attempts` : ''}): ${t.title}\nFiles: ${t.changed.join(', ') || 'none'}\nReport: ${(t.output || t.error || '').slice(0, 3000)}`),
  ].join('\n\n');
}

export function workerSystem(role: WorkerRoleId, de: boolean, personal = ''): string {
  const d = ROLE_DEFS[role];
  return [
    `You are the ${d.name} (${d.mention}) of an OpenCraft AI team. The Team Leader gave you one task. Other specialists work on other tasks at the same time.`,
    `Your scope: ${d.scope}`,
    'You work on the project files directly through MCP tools; the open apps show changes right away.',
    'Rules:',
    '1. Use tools instead of making up file contents. Read data before you evaluate it.',
    '2. Results of the tasks you depend on are in the <dependencies> block. Use their figures exactly.',
    '3. Write only your target files unless the task says otherwise. Paths start with /.',
    '4. If a tool reports an error, fix the arguments. Do not repeat the same failing call.',
    `5. End with a short report: what you did, the key figures and the files you changed. ${LANG_RULE(de)}`,
    personal,
  ]
    .filter(Boolean)
    .join('\n');
}

export function workerInput(task: TaskNode, deps: DependencyResult[], feedback?: string, context = ''): string {
  return [
    `Task ${task.id}: ${task.title}`,
    task.instructions,
    task.targetFiles.length ? `Target files: ${task.targetFiles.join(', ')}` : '',
    deps.length ? `<dependencies>\n${deps.map((d) => `<result task="${d.id}" agent="${ROLE_DEFS[d.agent].mention}" title="${d.title.replace(/"/g, "'")}">\nFiles: ${d.changed.join(', ') || 'none'}\n${d.output.slice(0, 8000)}\n</result>`).join('\n')}\n</dependencies>` : '',
    feedback ? `<leader-feedback>\nThe Team Leader rejected your last attempt. Fix exactly this:\n${feedback}\n</leader-feedback>` : '',
    context,
  ]
    .filter(Boolean)
    .join('\n\n');
}

// ---------------------------------------------------------------- Run state

export type TeamPhase = 'planning' | 'delegating' | 'reviewing' | 'completed' | 'stopped' | 'failed';
export type TaskStatus = 'pending' | 'running' | 'review' | 'retry' | 'done' | 'failed' | 'cancelled' | 'skipped';

export interface ToolCallSummary {
  name: string;
  ok: boolean;
  text?: string;
  path?: string;
}

export interface WorkerOutput {
  text: string;
  changed: string[];
  toolCalls: ToolCallSummary[];
  error?: string;
}

export interface ReviewVerdict {
  accept: boolean;
  instruction?: string;
  note?: string;
}

export interface DependencyResult {
  id: string;
  title: string;
  agent: WorkerRoleId;
  output: string;
  changed: string[];
}

export interface TaskState extends TaskNode {
  status: TaskStatus;
  attempts: number;
  started?: number;
  ended?: number;
  /** Final report of the sub-agent */
  output?: string;
  error?: string;
  changed: string[];
  toolCalls: ToolCallSummary[];
  /** Retry instructions of the leader, oldest first */
  feedback: string[];
  /** Last review note of the leader */
  verdict?: string;
  /** Live status line (thinking, tool call, waiting for a lock) */
  activity?: string;
  /** MCP tool running right now */
  tool?: string;
  /** Inline approval the user has to answer */
  approval?: { tool: string; title: string; args: Record<string, unknown> };
}

export interface TeamState {
  id: string;
  prompt: string;
  phase: TeamPhase;
  started: number;
  ended?: number;
  /** Direct @agent addressing: no planning, no leader review */
  direct?: boolean;
  goal?: string;
  tasks: TaskState[];
  /** Parser notes and problems of the plan */
  notes: string[];
  /** Raw plan of the leader (export) */
  plan?: string;
  leader: { activity?: string; reviews: { task: string; attempt: number; accept: boolean; note?: string; instruction?: string }[] };
  /** Tokens, latency and cost per role */
  usage: Record<string, RoleUsage>;
  summary?: string;
  error?: string;
  /** Snapshot of the configuration the run used */
  roster: { role: TeamRoleId; provider: string; model: string; effort: string }[];
  concurrency: number;
}

/** Calls into the models. The interface talks to the backend, the tests use scripted drivers. */
export interface TeamDriver {
  plan(prompt: string, correction: string | null, signal: AbortSignal): Promise<string>;
  work(task: TaskState, input: { deps: DependencyResult[]; feedback?: string; attempt: number }, signal: AbortSignal): Promise<WorkerOutput>;
  review?(task: TaskState, out: WorkerOutput, findings: string[], signal: AbortSignal): Promise<ReviewVerdict>;
  synthesize(prompt: string, tasks: TaskState[], signal: AbortSignal): Promise<string>;
}

export interface TeamRunOptions {
  config: TeamConfig;
  driver: TeamDriver;
  /** Skip planning: run this graph (direct @agent addressing) */
  graph?: TaskGraph;
  /** Only these specialists (several @agent mentions) */
  only?: WorkerRoleId[];
  onUpdate?: (state: TeamState) => void;
  id?: string;
  now?: () => number;
}

const ABORT = 'Stopped by the user.';

/** Automatic checks of a worker result: errors, failed tool calls that were never fixed, empty output. */
export function checkOutput(task: TaskNode, out: WorkerOutput): string[] {
  const findings: string[] = [];
  if (out.error) findings.push(`The sub-agent stopped with an error: ${out.error}`);
  const okNames = new Set(out.toolCalls.filter((c) => c.ok).map((c) => `${c.name}|${c.path || ''}`));
  for (const c of out.toolCalls) if (!c.ok && !okNames.has(`${c.name}|${c.path || ''}`)) findings.push(`${c.name}${c.path ? ` on ${c.path}` : ''} failed: ${(c.text || 'no message').slice(0, 200)}`);
  if (!out.text.trim() && !out.changed.length && !out.toolCalls.length) findings.push('The sub-agent returned nothing.');
  void task;
  return [...new Set(findings)];
}

/** Retry instruction from the automatic checks when the leader does not review. */
export function instructionFrom(findings: string[]): string {
  return `Fix these problems and finish the task:\n${findings.map((f) => `- ${f}`).join('\n')}`;
}

/** Reads the leader's review answer; malformed answers accept when the checks passed. */
export function parseVerdict(text: string, findings: string[]): ReviewVerdict {
  const r = repairJson(text)?.value as { accept?: unknown; instruction?: unknown; note?: unknown } | undefined;
  if (r && typeof r === 'object' && typeof r.accept === 'boolean') {
    const v: ReviewVerdict = { accept: r.accept };
    if (typeof r.instruction === 'string' && r.instruction.trim()) v.instruction = r.instruction.trim().slice(0, 2000);
    if (typeof r.note === 'string' && r.note.trim()) v.note = r.note.trim().slice(0, 300);
    if (!v.accept && !v.instruction) v.instruction = findings.length ? instructionFrom(findings) : 'Complete the task as instructed and report the result.';
    return v;
  }
  return findings.length ? { accept: false, instruction: instructionFrom(findings), note: 'review answer unreadable, automatic checks failed' } : { accept: true, note: 'review answer unreadable, automatic checks passed' };
}

/**
 * One team answer: plan, parallel work with per-task review and retries, synthesis.
 * stop() ends everything (master AbortController), cancel(id) ends one sub-agent; the others go on.
 */
export class TeamRun {
  readonly state: TeamState;
  private master = new AbortController();
  private workers = new Map<string, AbortController>();
  private cancelled = new Set<string>();
  private now: () => number;

  constructor(private opt: TeamRunOptions) {
    this.now = opt.now || (() => Date.now());
    const cfg = opt.config;
    this.state = {
      id: opt.id || `team-${Math.random().toString(36).slice(2, 9)}`,
      prompt: '',
      phase: 'planning',
      started: this.now(),
      tasks: [],
      notes: [],
      leader: { reviews: [] },
      usage: {},
      roster: [cfg.leader, ...cfg.workers.filter((w) => w.enabled && (!opt.only || opt.only.includes(w.role as WorkerRoleId)))].map((m) => ({ role: m.role, provider: m.provider, model: m.model, effort: m.effort })),
      concurrency: cfg.concurrency,
      ...(opt.graph ? { direct: true } : {}),
    };
  }

  get signal(): AbortSignal {
    return this.master.signal;
  }

  get running(): boolean {
    return !['completed', 'stopped', 'failed'].includes(this.state.phase);
  }

  /** Active sub-agents right now. */
  get active(): number {
    return this.state.tasks.filter((t) => t.status === 'running').length;
  }

  emit(): void {
    this.opt.onUpdate?.(this.state);
  }

  /** Token usage of one model request of a role (leader or a specialist). */
  addUsage(role: TeamRoleId, u: TokenUsage, toolCalls = 0): void {
    addRoleUsage(this.state.usage, role, u, toolCalls);
    this.emit();
  }

  addToolCall(role: TeamRoleId, ok: boolean, ms: number): void {
    const r = this.state.usage[role];
    if (r) {
      r.toolCalls = (r.toolCalls || 0) + 1;
      r.toolOk = (r.toolOk || 0) + (ok ? 1 : 0);
      r.toolMs = (r.toolMs || 0) + ms;
    }
  }

  stop(): void {
    if (!this.master.signal.aborted) this.master.abort();
  }

  /** Cancels one sub-agent. Tasks that depend on it are skipped, the rest of the team goes on. */
  cancel(taskId: string): void {
    const t = this.state.tasks.find((x) => x.id === taskId);
    if (!t) return;
    this.cancelled.add(taskId);
    if (t.status === 'pending') {
      t.status = 'cancelled';
      t.ended = this.now();
      this.emit();
    }
    this.workers.get(taskId)?.abort();
  }

  async run(prompt: string): Promise<TeamState> {
    const s = this.state;
    s.prompt = prompt;
    const enabled = enabledWorkers(this.opt.config, this.opt.only);
    try {
      // Stage 1: plan
      let graph = this.opt.graph;
      if (!graph) {
        s.phase = 'planning';
        s.leader.activity = 'Breaking the request into tasks';
        this.emit();
        let text = await this.opt.driver.plan(prompt, null, this.signal);
        s.plan = text;
        let parsed = parseTaskGraph(text, { enabled });
        if (!parsed.ok && !this.signal.aborted) {
          // One correction turn for the leader, then the parser repairs what is left
          s.notes.push(...parsed.issues.map((x) => `plan corrected: ${x}`));
          s.leader.activity = 'Correcting the plan';
          this.emit();
          text = await this.opt.driver.plan(prompt, parsed.issues.join('\n'), this.signal);
          s.plan = text;
          parsed = parseTaskGraph(text, { enabled, fallback: true });
        }
        s.notes.push(...parsed.notes);
        if (!parsed.graph.tasks.length) throw new Error('The Team Leader returned no tasks.');
        graph = parsed.graph;
      }
      s.goal = graph.goal;
      s.tasks = graph.tasks.map((t) => ({ ...t, status: 'pending', attempts: 0, changed: [], toolCalls: [], feedback: [] }));
      s.leader.activity = undefined;
      // Stage 2 and 3: work and review
      await this.schedule();
      if (this.signal.aborted) throw abortError();
      // Final synthesis
      s.phase = 'reviewing';
      s.leader.activity = s.direct ? undefined : 'Writing the summary';
      this.emit();
      const ok = s.tasks.filter((t) => t.status === 'done');
      if (s.direct && s.tasks.length === 1) s.summary = s.tasks[0]!.output || s.tasks[0]!.error || '';
      else s.summary = await this.opt.driver.synthesize(prompt, s.tasks, this.signal);
      s.phase = ok.length || !s.tasks.length ? 'completed' : 'failed';
      if (s.phase === 'failed') s.error ||= 'No task finished.';
    } catch (e) {
      const aborted = this.signal.aborted || (e as Error).name === 'AbortError';
      s.phase = aborted ? 'stopped' : 'failed';
      if (!aborted) s.error = (e as Error).message;
      for (const t of s.tasks) {
        if (t.status === 'pending' || t.status === 'running' || t.status === 'review' || t.status === 'retry') {
          t.status = aborted ? 'cancelled' : 'skipped';
          t.ended ||= this.now();
          t.approval = undefined;
        }
      }
      if (aborted) s.summary = partialSummary(s);
    } finally {
      s.leader.activity = undefined;
      s.ended = this.now();
      for (const t of s.tasks) (t.activity = undefined), (t.tool = undefined);
      this.emit();
    }
    return s;
  }

  /** Starts every ready task up to the concurrency limit; dependents start as soon as theirs are done. */
  private async schedule(): Promise<void> {
    const s = this.state;
    const running = new Map<string, Promise<void>>();
    const limit = Math.max(1, this.opt.config.concurrency);
    const byId = new Map(s.tasks.map((t) => [t.id, t]));
    for (;;) {
      if (this.signal.aborted) break;
      // A task whose dependency failed or was cancelled cannot run
      let changed = false;
      for (const t of s.tasks) {
        if (t.status !== 'pending') continue;
        const bad = t.dependencies.map((d) => byId.get(d)!).find((d) => d && ['failed', 'cancelled', 'skipped'].includes(d.status));
        if (bad) {
          t.status = 'skipped';
          t.error = `Skipped: ${bad.id} ${bad.status === 'cancelled' ? 'was cancelled' : 'did not finish'}.`;
          t.ended = this.now();
          changed = true;
        }
      }
      const ready = s.tasks.filter((t) => t.status === 'pending' && t.dependencies.every((d) => byId.get(d)?.status === 'done'));
      for (const t of ready) {
        if (running.size >= limit) break;
        const p = this.runTask(t).finally(() => running.delete(t.id));
        running.set(t.id, p);
        changed = true;
      }
      if (changed) {
        s.phase = 'delegating';
        this.emit();
      }
      if (!running.size) break;
      await Promise.race(running.values());
    }
    // Drain: every sub-agent ends (also after Stop All, their streams close through the signal)
    await Promise.allSettled(running.values());
  }

  private async runTask(t: TaskState): Promise<void> {
    const s = this.state;
    const byId = new Map(s.tasks.map((x) => [x.id, x]));
    const deps: DependencyResult[] = t.dependencies.map((d) => byId.get(d)!).map((d) => ({ id: d.id, title: d.title, agent: d.assignedAgent, output: d.output || '', changed: d.changed }));
    const max = 1 + Math.max(0, this.opt.config.maxRetries);
    for (let attempt = 1; attempt <= max; attempt++) {
      const ac = new AbortController();
      const onMaster = () => ac.abort();
      this.master.signal.addEventListener('abort', onMaster, { once: true });
      this.workers.set(t.id, ac);
      t.status = attempt > 1 ? 'retry' : 'running';
      t.attempts = attempt;
      t.started ??= this.now();
      t.activity = attempt > 1 ? 'Retrying with the leader feedback' : 'Starting';
      this.emit();
      t.status = 'running';
      let out: WorkerOutput;
      try {
        if (this.cancelled.has(t.id)) ac.abort();
        out = await this.opt.driver.work(t, { deps, feedback: t.feedback.at(-1), attempt }, ac.signal);
      } catch (e) {
        out = { text: '', changed: [], toolCalls: [], error: (e as Error).message };
      } finally {
        this.master.signal.removeEventListener('abort', onMaster);
        this.workers.delete(t.id);
      }
      t.tool = undefined;
      t.approval = undefined;
      t.changed = [...new Set([...t.changed, ...out.changed])];
      t.toolCalls.push(...out.toolCalls);
      if (ac.signal.aborted) {
        t.status = 'cancelled';
        t.output = out.text || t.output;
        t.error = ABORT;
        t.ended = this.now();
        t.activity = undefined;
        this.emit();
        return;
      }
      t.output = out.text;
      t.error = out.error;
      // Stage 3: review
      const findings = checkOutput(t, out);
      let verdict: ReviewVerdict;
      if (this.opt.config.review === 'leader' && this.opt.driver.review && !s.direct) {
        t.status = 'review';
        t.activity = 'The Team Leader reviews the result';
        s.phase = this.active ? 'delegating' : 'reviewing';
        s.leader.activity = `Reviewing ${t.id}`;
        this.emit();
        try {
          verdict = await this.opt.driver.review(t, out, findings, this.signal);
        } catch (e) {
          if (this.signal.aborted) throw e;
          verdict = findings.length ? { accept: false, instruction: instructionFrom(findings), note: `review failed: ${(e as Error).message}` } : { accept: true, note: 'review failed, automatic checks passed' };
        }
        if (s.leader.activity === `Reviewing ${t.id}`) s.leader.activity = undefined;
      } else verdict = findings.length ? { accept: false, instruction: instructionFrom(findings), note: findings[0] } : { accept: true };
      if (this.cancelled.has(t.id)) {
        t.status = 'cancelled';
        t.error = ABORT;
        t.ended = this.now();
        t.activity = undefined;
        this.emit();
        return;
      }
      s.leader.reviews.push({ task: t.id, attempt, accept: verdict.accept, ...(verdict.note ? { note: verdict.note } : {}), ...(verdict.instruction && !verdict.accept ? { instruction: verdict.instruction } : {}) });
      t.verdict = verdict.note;
      if (verdict.accept) {
        t.status = 'done';
        t.ended = this.now();
        t.activity = undefined;
        this.emit();
        return;
      }
      if (attempt < max && !this.cancelled.has(t.id)) {
        t.feedback.push(verdict.instruction || instructionFrom(findings));
        t.status = 'retry';
        this.emit();
        continue;
      }
      t.status = 'failed';
      t.error ||= verdict.note || findings[0] || 'Rejected by the Team Leader.';
      t.ended = this.now();
      t.activity = undefined;
      this.emit();
      return;
    }
  }
}

function abortError(): Error {
  return Object.assign(new Error(ABORT), { name: 'AbortError' });
}

/** What a stopped run leaves behind. */
export function partialSummary(s: TeamState): string {
  const done = s.tasks.filter((t) => t.status === 'done');
  const files = [...new Set(done.flatMap((t) => t.changed))];
  return [`Team stopped. ${done.length} of ${s.tasks.length} tasks finished.`, files.length ? `Files written: ${files.join(', ')}` : ''].filter(Boolean).join(' ');
}

// ---------------------------------------------------------------- Export

export function teamToMarkdown(s: TeamState, threadMd?: (taskId: string) => string): string {
  const out: string[] = [];
  out.push(`#### Team Mission Control: ${s.phase}${s.ended ? `, ${((s.ended - s.started) / 1000).toFixed(1)} s` : ''}`);
  if (s.goal) out.push(`Goal: ${s.goal}`);
  out.push(`Roster: ${s.roster.map((r) => `${ROLE_DEFS[r.role].name} (${r.provider || 'default'}${r.model ? ` · ${r.model}` : ''}${r.effort !== 'auto' ? ` · ${r.effort}` : ''})`).join('; ')}`);
  if (s.tasks.length) {
    out.push(['| Task | Agent | Depends on | Target files | Status | Attempts |', '|---|---|---|---|---|---|', ...s.tasks.map((t) => `| ${t.id} ${t.title.replace(/\|/g, '/')} | ${ROLE_DEFS[t.assignedAgent].mention} | ${t.dependencies.join(', ') || '–'} | ${t.targetFiles.join(', ') || '–'} | ${t.status} | ${t.attempts} |`)].join('\n'));
  }
  const roles = Object.values(s.usage);
  if (roles.length) out.push(['| Role | Model | Input | Output | Cached | Requests | Latency |', '|---|---|---|---|---|---|---|', ...roles.map((r) => `| ${ROLE_DEFS[r.role as TeamRoleId]?.name || r.role} | ${r.model} | ${r.input} | ${r.output} | ${r.cached} | ${r.requests} | ${r.totalMs} ms |`)].join('\n'));
  for (const rv of s.leader.reviews) out.push(`Review ${rv.task} attempt ${rv.attempt}: ${rv.accept ? 'accepted' : 'retry'}${rv.note ? `, ${rv.note}` : ''}${rv.instruction ? `\n> ${rv.instruction.replace(/\n/g, '\n> ')}` : ''}`);
  for (const t of s.tasks) {
    out.push(`##### Sub-agent ${ROLE_DEFS[t.assignedAgent].name}: ${t.id} ${t.title}`);
    if (t.feedback.length) out.push(t.feedback.map((f, i) => `Leader feedback ${i + 1}: ${f}`).join('\n'));
    const thread = threadMd?.(t.id);
    if (thread) out.push(thread);
    else if (t.output) out.push(t.output);
  }
  if (s.notes.length) out.push(`Plan notes: ${s.notes.join('; ')}`);
  return out.join('\n\n');
}
