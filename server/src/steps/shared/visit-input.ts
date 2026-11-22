import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { DocumentRepository } from '../../history/document.repository';
import type { RunEntity } from '../../history/run.entity';
import { readPlanChat, PLAN_CHAT_KIND } from '../../contract/plan-chat';
import { git } from '../../git/worktree-tree';
import { mountsForRun } from '../../sandbox/sandbox-launch';
import { ARTIFACTS } from '../contract/artifacts';
import type { Issue } from '../contract/step-contract';
import { currentPlan } from './current-plan';
import { handoffText } from './handoff';

/** What an agent visit is given, as texts. Nothing here is a time, an id or a counter. */
export interface VisitInputParts {
  heads: { repo: string; commit: string }[];
  checklist: string[];
  handoff: string;
  answers: string[];
  returns: string[];
  findings: string[];
  instruction: string;
}

const ISO_TIME = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g;
const EPOCH_MS = /\b\d{13}\b/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ATTEMPT_ID = /\battempt[-_][0-9a-z][0-9a-z_-]*/gi;
const COUNTED = /\b(attempt|visit|revision|try|round)\b[\s#:]*\d+/gi;

/** The text without its times, ids and counters, so the same content stamped anew reads the same. */
export function normalizedText(text: string): string {
  return text
    .replace(ISO_TIME, '')
    .replace(UUID, '')
    .replace(ATTEMPT_ID, '')
    .replace(COUNTED, '$1')
    .replace(EPOCH_MS, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The part separator and the list separator: control characters a normalized text never holds. */
const PART_END = '\u001e';
const ITEM_END = '\u001f';

function listOf(items: string[]): string {
  return items.map((item) => `${normalizedText(item)}${ITEM_END}`).join('');
}

/** A sha256 hex of the normalized parts in a fixed order. Pure: the same texts always give the same digest. */
export function visitInput(parts: VisitInputParts): string {
  const heads = [...parts.heads]
    .sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0))
    .map((head) => `${normalizedText(head.repo)}=${head.commit.trim()}`);
  const text = [
    heads.join(ITEM_END),
    listOf(parts.checklist),
    normalizedText(parts.handoff),
    listOf(parts.answers),
    listOf(parts.returns),
    listOf(parts.findings),
    normalizedText(parts.instruction),
  ].join(PART_END);
  return createHash('sha256').update(text).digest('hex');
}

interface VisitInputDeps {
  documents: DocumentRepository;
  /** The folder of the run's worktrees, as the sandbox mounts it. */
  worktrees: string;
}

type Reader = Pick<(typeof ARTIFACTS)[keyof typeof ARTIFACTS], 'readers'>;

function takes(artifact: Reader, step: string): boolean {
  return (artifact.readers as readonly string[]).includes(step);
}

async function headsOf(deps: VisitInputDeps, run: Pick<RunEntity, 'targetPath'>): Promise<VisitInputParts['heads']> {
  const heads: VisitInputParts['heads'] = [];
  for (const mount of mountsForRun(deps.worktrees, run.targetPath)) {
    // A mount that is not a work tree (a bare remote, no repository) or has no commit yet has no head to read.
    const [inside, head] = await git(mount.hostPath, ['rev-parse', '--is-inside-work-tree', 'HEAD']).then(
      (out) => out.trim().split('\n'),
      () => [],
    );
    if (inside === 'true' && head) {
      heads.push({ repo: basename(mount.hostPath), commit: head });
    }
  }
  return heads;
}

function findingsOf(body: string | null): string[] {
  const issues: Issue[] = body ? ARTIFACTS.issues.parse(body) : [];
  return issues.map((issue) => `${issue.source}\n${issue.title}\n${issue.body}`);
}

/** Gathers the parts of the input of one step's visit from the run's documents, its plan chat and its worktrees. */
export async function readVisitInput(
  deps: VisitInputDeps,
  run: Pick<RunEntity, 'key' | 'targetPath'>,
  step: string,
  instruction = '',
): Promise<string> {
  const { documents } = deps;
  const stored = (artifact: Reader & { kind: string }) =>
    takes(artifact, step) ? documents.latestBody(run.key, artifact.kind) : Promise.resolve(null);
  const [plan, handoff, answers, returns, issues, chat] = await Promise.all([
    currentPlan(documents, run.key),
    stored(ARTIFACTS.handoff),
    stored(ARTIFACTS.answers),
    stored(ARTIFACTS.return),
    stored(ARTIFACTS.issues),
    documents.latestBody(run.key, PLAN_CHAT_KIND),
  ]);
  const messages = readPlanChat(chat)
    .entries.filter((entry) => entry.kind === undefined || entry.kind === 'answer')
    .map((entry) => entry.text);
  return visitInput({
    heads: await headsOf(deps, run),
    checklist: plan?.items ?? [],
    handoff: handoffText(handoff),
    answers: [...(answers ? [answers] : []), ...messages],
    returns: returns ? [returns] : [],
    findings: findingsOf(issues),
    instruction,
  });
}
