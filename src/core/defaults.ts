// Defaults shared by the backend and browser mode.

export interface PersonaDef {
  id: string;
  name: string;
  prompt: string;
  builtIn?: boolean;
}

/** Built-in personas, editable in Settings, Personal context. */
export const DEFAULT_PERSONAS: PersonaDef[] = [
  { id: 'default', name: 'OpenCraft assistant', prompt: '', builtIn: true },
  { id: 'finance', name: 'Financial analyst', prompt: 'Act as a careful financial analyst. Work with exact numbers from the files, show formulas and assumptions, flag risks and outliers, and separate facts from estimates.', builtIn: true },
  { id: 'copywriter', name: 'Copywriter', prompt: 'Act as a senior copywriter. Write clear, concrete and active sentences, match the tone of the audience, and offer two short alternatives for headlines.', builtIn: true },
  { id: 'reviewer', name: 'Strict reviewer', prompt: 'Act as a strict reviewer. Look for errors, gaps, contradictions and unclear claims first. Rank findings by severity, quote the exact place and propose a fix. Do not praise.', builtIn: true },
];

/** Host of a URL is this computer or the home network (no cloud). */
export function isLocalUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (h === 'localhost' || h.endsWith('.local') || h === '::1' || h.startsWith('127.')) return true;
    if (/^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^169\.254\./.test(h)) return true;
    if (/^f[cd][0-9a-f]{2}:/.test(h) || h.startsWith('fe80:')) return true;
    return false;
  } catch {
    return false;
  }
}

/** System prompt part for the persona and the personal context. */
export function personalPrompt(p: { context: string; active: string; personas: PersonaDef[] } | null | undefined): string {
  if (!p) return '';
  const persona = p.personas.find((x) => x.id === p.active);
  const parts: string[] = [];
  if (persona?.prompt.trim()) parts.push(`Role for this chat (${persona.name}): ${persona.prompt.trim()}`);
  if (p.context.trim()) parts.push(`About the user (personal context, set by the user): ${p.context.trim()}`);
  return parts.join('\n');
}
