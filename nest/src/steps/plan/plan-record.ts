import { PlanFields } from '../../providers/requirements-record';
import { SwarmloopError } from '../../swarmloop-error';
import { bulletSection } from '../markdown-section';

export function parsePlan(text: string): string {
  return bulletSection(text, 'plan');
}

/** Checklist from the answer, or from the plan tool in the stream. */
export function planFromAgent(responseText: string, output = ''): PlanFields {
  try {
    const written = fieldsFromSection(responseText);
    if (written) {
      return written;
    }
  } catch (error) {
    if (!(error instanceof SwarmloopError) || error.message !== 'plan is missing') {
      throw error;
    }
  }
  const recovered = fieldsFromStream(output);
  if (!recovered) {
    throw new SwarmloopError('plan is missing');
  }
  return recovered;
}

export function joinPrompt(prior: string | null | undefined, text: string): string {
  const base = prior?.trim() ?? '';
  if (!base || base === text) {
    return text;
  }
  if (base.endsWith(`\n\n${text}`)) {
    return base;
  }
  return `${base}\n\n${text}`;
}

/** Keep the requirements record and add the new instructions to its prompt. */
export function withInstructions(requirementsBody: string, text: string, revisePlan: boolean): string {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(requirementsBody) as Record<string, unknown>;
  } catch {
    throw new SwarmloopError('requirements is not readable');
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new SwarmloopError('requirements is not readable');
  }
  const prompt = joinPrompt(typeof record.prompt === 'string' ? record.prompt : '', text);
  const next: Record<string, unknown> = { ...record, prompt };
  const plan = record.plan;
  if (revisePlan && plan && typeof plan === 'object' && !Array.isArray(plan)) {
    next.plan = { ...plan, decision: 'revise' };
  }
  return `${JSON.stringify(next, null, 2)}\n`;
}

export function withPlan(requirementsBody: string, plan: PlanFields): string {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(requirementsBody) as Record<string, unknown>;
  } catch {
    throw new SwarmloopError('requirements is not readable');
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new SwarmloopError('requirements is not readable');
  }
  return `${JSON.stringify({ ...record, plan }, null, 2)}\n`;
}

export function readPlan(body: string | null): PlanFields | null {
  if (!body?.trim()) {
    return null;
  }
  try {
    const record = JSON.parse(body) as { plan?: unknown };
    return asPlan(record.plan);
  } catch {
    return null;
  }
}

/** Checklist the review returned. Empty when the review kept the plan it was given. */
export function reviewedItems(text: string, output = ''): string[] {
  try {
    return planFromAgent(text, output).items;
  } catch (error) {
    if (error instanceof SwarmloopError && error.message === 'plan is missing') {
      return [];
    }
    throw error;
  }
}

export function requireApprovedPlan(requirements: string | null): string {
  const plan = readPlan(requirements);
  if (!plan?.items.length) {
    throw new SwarmloopError('plan is missing');
  }
  if (plan.decision !== 'approve') {
    throw new SwarmloopError('plan is not approved');
  }
  return `${JSON.stringify(plan, null, 2)}\n`;
}

function fieldsFromSection(text: string): PlanFields | null {
  const items = parsePlan(text)
    .split('\n')
    .map((line) => line.replace(/^- /, '').trim())
    .filter((line) => line !== '');
  return items.length > 0 ? { name: '', overview: '', items, decision: null } : null;
}

function fieldsFromStream(raw: string): PlanFields | null {
  let found: PlanFields | null = null;
  for (const line of raw.split('\n')) {
    const record = jsonRecord(line);
    if (!record) {
      continue;
    }
    const spoken = textOf(record);
    if (spoken) {
      try {
        const fields = fieldsFromSection(spoken);
        if (fields) {
          found = fields;
        }
      } catch (error) {
        if (!(error instanceof SwarmloopError)) {
          throw error;
        }
      }
    }
    const tool = toolPlan(record);
    if (tool) {
      found = tool;
    }
  }
  return found;
}

function toolPlan(record: Record<string, unknown>): PlanFields | null {
  const call = record.tool_call;
  if (!isRecord(call)) {
    return null;
  }
  for (const [name, body] of Object.entries(call)) {
    if (!/createplan/i.test(name) || !isRecord(body)) {
      continue;
    }
    const args = isRecord(body.args) ? body.args : body;
    const items = todoItems(args.todos) ?? markdownItems(typeof args.plan === 'string' ? args.plan : '');
    if (!items) {
      continue;
    }
    return {
      name: typeof args.name === 'string' ? args.name.trim() : '',
      overview: typeof args.overview === 'string' ? args.overview.trim() : '',
      items,
      decision: null,
    };
  }
  return null;
}

function todoItems(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const lines = value
    .map((item) => (isRecord(item) && typeof item.content === 'string' ? item.content.trim() : ''))
    .filter((line) => line !== '' && line !== 'none');
  return lines.length > 0 ? lines : null;
}

function markdownItems(plan: string): string[] | null {
  const lines = plan
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
    .filter((line) => line !== '' && line !== 'none');
  return lines.length > 0 ? lines : null;
}

function asPlan(value: unknown): PlanFields | null {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    return null;
  }
  const items = value.items.filter((item): item is string => typeof item === 'string' && item.trim() !== '' && item.trim() !== 'none');
  if (items.length === 0) {
    return null;
  }
  const decision = value.decision === 'approve' || value.decision === 'revise' ? value.decision : null;
  return {
    name: typeof value.name === 'string' ? value.name : '',
    overview: typeof value.overview === 'string' ? value.overview : '',
    items,
    decision,
  };
}

function textOf(record: Record<string, unknown>): string | null {
  if (typeof record.result === 'string') {
    return record.result;
  }
  const message = record.message;
  if (!isRecord(message)) {
    return null;
  }
  const content = message.content;
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const text = content
    .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
    .join('');
  return text === '' ? null : text;
}

function jsonRecord(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

