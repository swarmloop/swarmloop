import type { PlanFields } from '../../integrations/requirements-source/requirements-record';
import { SwarmloopError } from '../../core/swarmloop-error';
import { legacyPlanItems, legacyPlanObjectItems } from '../../agent-result/legacy/plan';

/** The plan inside the requirements record, written from what the planner sent. The decision is the person's. */
export function planFields(items: string[], name = '', overview = ''): PlanFields {
  return { name, overview, items, decision: null };
}

/** The handoff text of an answer's summary lines, or of the checklist when the agent sent none. */
export function renderSummary(summary: string[], items: string[]): string {
  const lines = summary.filter((line) => line.trim() && line.trim() !== 'none');
  return `${(lines.length > 0 ? lines : items).map((line) => `- ${line}`).join('\n')}\n`;
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

/** Bullets or the stored plan object in an answer's `plan:` section. Null when that answer has no corrected checklist. */
export function correctedItems(text: string, _output = ''): string[] | null {
  const items = legacyPlanItems(text);
  return items.length > 0 ? items : legacyPlanObjectItems(text);
}

/** Checklist the implement answer corrected. Null when the answer leaves the approved plan. */
export function correctedPlan(
  requirementsBody: string,
  text: string,
  output = '',
): { requirements: string; handoff: string } | null {
  const items = correctedItems(text, output);
  if (!items) {
    return null;
  }
  const current = readPlan(requirementsBody);
  const previous = current?.items ?? [];
  if (previous.length === items.length && previous.every((item, index) => item === items[index])) {
    return null;
  }
  const dropped = previous.filter((item) => !items.includes(item));
  const added = items.filter((item) => !previous.includes(item));
  const named = [...dropped.map((item) => `dropped "${item}"`), ...added.map((item) => `added "${item}"`)].join('; ');
  const handoff = `- ${named || 'reordered the checklist'} because a pipeline return or a later instruction outranks the checklist\n`;
  return {
    requirements: withPlan(requirementsBody, {
      name: current?.name ?? '',
      overview: current?.overview ?? '',
      items,
      decision: 'approve',
    }),
    handoff,
  };
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

function asPlan(value: unknown): PlanFields | null {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    return null;
  }
  const items = value.items.filter(
    (item): item is string => typeof item === 'string' && item.trim() !== '' && item.trim() !== 'none',
  );
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
