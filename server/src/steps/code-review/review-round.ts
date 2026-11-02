import { readFileSync } from 'fs';
import { basename, join } from 'path';
import { SwarmloopEnv } from '../../config/env';
import { liveLogBody } from '../../acp/live-output';
import { HistoryService } from '../../history/history.service';
import { DocumentDraft } from '../../history/visit';
import { OpenedStep } from '../../pipeline/step-run';
import { agentStateDir, SandboxMount } from '../../sandbox/sandbox-launch';
import { withReturnNotes } from '../implement/implement-record';
import { textDocument, withHandoff } from '../shared/handoff';
import { skillPrompt } from '../shared/skill-prompt';
import { parseReview } from './code-review-record';
import { decidedOk, Finished, fixNotes, Opinion, recordAngle, REVIEWERS, Reviewer, ReviewDeps, runJob } from './reviewer';

export interface Selection {
  kept: Opinion[];
  pending: Reviewer[];
  recovered: DocumentDraft[];
  stale: Set<string>;
}

export interface SelectInput {
  key: string;
  only: string | undefined;
  fresh: boolean;
  retry: boolean;
  same: boolean;
  repeated: boolean;
}

export interface RoundInput {
  opened: OpenedStep;
  key: string;
  env: SwarmloopEnv;
  pending: Reviewer[];
  stale: Set<string>;
  requirements: string;
  notes: string | null;
  mounts: SandboxMount[];
  handoff: string | null;
  returned: string | null;
  diff: { heading: string; body: string };
  plan: string;
  auto: boolean | undefined;
  fresh: boolean;
  retry: boolean;
  repeated: boolean;
}

export async function selectReviewers(history: HistoryService, input: SelectInput): Promise<Selection> {
  const { key, only, fresh, retry, same, repeated } = input;
  const kept: Opinion[] = [];
  const pending: Reviewer[] = [];
  const recovered: DocumentDraft[] = [];
  const stale = new Set<string>();
  for (const reviewer of REVIEWERS) {
    if (fresh) {
      if (!only || only === reviewer.name) {
        pending.push(reviewer);
      }
      continue;
    }
    if (only === reviewer.name) {
      pending.push(reviewer);
      continue;
    }
    const stored = !fresh && (Boolean(only) || retry || same) ? await history.latestBody(key, reviewer.kind) : null;
    if (stored) {
      try {
        const parsed = parseReview(stored);
        if (staleReturn(repeated, parsed.decision)) {
          stale.add(reviewer.name);
        } else if (only || retry || parsed.decision === 'ok') {
          kept.push({ kind: reviewer.kind, decision: parsed.decision, body: stored });
          continue;
        }
      } catch {
        // launch or leave open
      }
    }
    if (retry && !only) {
      try {
        const parsed = parseReview(liveLogBody(history.root(), key, `code-review-${reviewer.name}`));
        if (staleReturn(repeated, parsed.decision)) {
          stale.add(reviewer.name);
        } else {
          kept.push({ kind: reviewer.kind, decision: parsed.decision, body: parsed.body });
          recovered.push(textDocument(reviewer.kind, parsed.body));
          continue;
        }
      } catch {
        // launch this reviewer again
      }
    }
    if (!only) {
      pending.push(reviewer);
    }
  }
  return { kept, pending, recovered, stale };
}

/** Runs every pending angle together, then stores their visits once all of them have finished. */
export async function runRound(deps: ReviewDeps, input: RoundInput): Promise<Finished[]> {
  const jobs = input.pending.map((reviewer) => ({ ...reviewJob(reviewer, input), stale: input.stale.has(reviewer.name) }));
  const fix = fixNotes(await deps.history.listDocuments(input.opened.run.id), input.handoff);
  const finished = await Promise.all(jobs.map((job) => runJob(deps, input.opened, input.key, input.env, job, fix, input.plan, input.returned, input.auto, input.fresh, input.retry)));
  for (const item of finished) {
    await recordAngle(deps, input.opened, item, input.repeated);
  }
  return finished;
}

export function reviewReturn(returned: string | null): boolean {
  if (!returned?.trim()) {
    return false;
  }
  const lines = returned.split(/\r?\n/).map((line) => line.trim());
  return !(lines.includes('## pipeline') && lines.includes('result: fail'));
}

export function sameReviewedDiff(root: string, key: string, patch: string): boolean {
  try {
    const previous = readFileSync(join(agentStateDir(root, key, 'code-review-requirements'), 'briefs', 'diff.md'), 'utf8');
    return previous === patch;
  } catch {
    return false;
  }
}

export function acceptRepeated(documents: DocumentDraft[], opinions: Opinion[]): DocumentDraft[] {
  const kinds = new Set(opinions.filter((item) => item.decision === 'return').map((item) => item.kind));
  return documents.map((document) => (kinds.has(document.kind) ? { ...document, body: decidedOk(document.body) } : document));
}

function staleReturn(repeated: boolean, decision: 'ok' | 'return'): boolean {
  return repeated && decision === 'return';
}

function reviewJob(reviewer: Reviewer, input: RoundInput) {
  const names = input.mounts.map((mount) => basename(mount.hostPath));
  const notesSection = input.notes?.trim() ? [{ heading: 'Implementation', body: input.notes }] : [];
  const planSection = input.plan.trim() ? [{ heading: 'Plan', body: input.plan }] : [];
  const sections = withHandoff(withReturnNotes([input.diff, ...notesSection, ...planSection], input.returned), input.handoff);
  return {
    reviewer,
    model: input.env.MODEL_PLAN,
    prompt: skillPrompt(`code-review/${reviewer.name}`, input.requirements, names, sections, input.mounts),
    mounts: input.mounts,
  };
}
