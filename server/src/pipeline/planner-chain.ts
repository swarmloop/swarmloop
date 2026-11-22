import { createHash } from 'node:crypto';
import type { Clock } from '../core/clock';
import type { PlanChatEntry } from '../contract/plan-chat';
import { parseSubtasks, SUBTASKS_KIND, CONTRACT_KIND, type Subtask } from '../contract/subtask';
import type { DocumentRepository } from '../history/document.repository';
import type { RunEntity } from '../history/entities';
import type { PlanChatStore } from '../history/plan-chat.store';
import type { RunRepository } from '../history/run.repository';
import { ARTIFACTS } from '../steps/contract/artifacts';
import { mergeHandoff } from '../steps/shared/handoff';
import type { PlanConversation } from '../steps/shared/plan-conversation';
import type { ChainAsked, ChainQuestion } from '../steps/shared/subtask-ops';
import { normalizedText } from '../steps/shared/visit-input';
import type { OpenedStep } from '../steps/step-run';
import { escalateToPerson } from './escalation';
import { askPlanner, openedFor } from './planner-question';

/** The levels of one run that answered a question, by the normalized text of the question. */
const LEVELS_KIND = 'question_levels';
/** The keys of the question entries the chain writes into a run's plan chat. */
const ENTRY_PREFIX = 'up-';

/** What the chain needs of the levels above a subtask: its parent's planner, and its parent's questions for the person. */
interface ChainAncestors {
  askAbout(opened: OpenedStep, task: Subtask, question: string, contract: string): Promise<string | null>;
  /** Puts a question of a task of `parent` among the questions of `parent` for whoever started the run. */
  handUp(parent: RunEntity, taskId: string, text: string): Promise<void>;
}

/** The key of the entry a question has in the plan chat: the same question is the same entry. */
function entryKey(question: ChainQuestion): string {
  return `${ENTRY_PREFIX}${createHash('sha1').update(normalizedText(question.text)).digest('hex').slice(0, 10)}`;
}

/** What one level gave: an answer, an escalation that goes straight to the person, or nothing usable. */
type Reply = { kind: 'answered'; text: string } | { kind: 'escalated' } | { kind: 'none' };

/**
 * A question of a run climbs the planners' chain: the run's own planner, the planner of each epic above it, and last
 * whoever started the run. Each answer that changes nothing moves the same question one level up, so the chain ends at
 * the person. It never starts the run: the caller does, as a planner start of the level that answered.
 */
export class PlannerChain {
  private readonly chat: PlanChatStore;
  private readonly clock: Clock;

  constructor(
    private readonly ancestors: ChainAncestors,
    private readonly conversation: PlanConversation,
    private readonly documents: DocumentRepository,
    private readonly runs: RunRepository,
  ) {
    this.chat = conversation.chat;
    this.clock = conversation.clock;
  }

  async askUp(run: RunEntity, question: ChainQuestion, startLevel: number): Promise<ChainAsked> {
    const key = normalizedText(question.text);
    const above = await this.epicsAbove(run);
    const starter = above.length + 1;
    const levels = await this.levels(run);
    const done = levels[key] ?? [];
    let level = Math.min(starter, Math.max(startLevel, done.length > 0 ? Math.max(...done) + 1 : 0));
    for (; level < starter; level++) {
      const reply = level === 0 ? await this.own(run, question) : await this.epic(run, above, level, question);
      if (reply.kind === 'escalated') {
        level = starter;
        break;
      }
      if (reply.kind === 'answered') {
        await this.remember(run, levels, key, level);
        return { asked: level === 0 ? 'run-planner' : 'epic-planner', level, answer: reply.text };
      }
    }
    if (!done.includes(starter)) {
      await this.toStarter(run, above[0] ?? null, question);
      await this.remember(run, levels, key, starter);
    }
    return { asked: 'starter', level: starter, answer: null };
  }

  /** The question the chain left open in the run's plan chat for its planner, or null. */
  async openQuestion(run: RunEntity): Promise<PlanChatEntry | null> {
    const open = await this.chat.pendingQuestions(run.key);
    return open.find((entry) => entry.key.startsWith(ENTRY_PREFIX)) ?? null;
  }

  /** The epics above the run, the nearest first. */
  private async epicsAbove(run: RunEntity): Promise<RunEntity[]> {
    const found: RunEntity[] = [];
    for (let at = run; typeof at.parentRunId === 'number';) {
      const parent = await this.runs.findById(at.parentRunId);
      if (!parent) break;
      found.push(parent);
      at = parent;
    }
    return found;
  }

  private async own(run: RunEntity, question: ChainQuestion): Promise<Reply> {
    const key = entryKey(question);
    const entry: PlanChatEntry = {
      key,
      role: 'planner',
      kind: 'question',
      from: question.from,
      text: question.text,
      at: this.clock.iso(),
      state: 'pending',
    };
    await this.chat.appendEntry(run.key, entry);
    const known = (await this.chat.read(run.key)).entries.find((item) => item.key === key) ?? entry;
    const outcome = await askPlanner(
      { chat: this.chat, conversation: this.conversation, clock: this.clock },
      run,
      known,
    );
    if (outcome.kind !== 'answered') return outcome.kind === 'escalated' ? { kind: 'escalated' } : { kind: 'none' };
    const answer = (await this.chat.read(run.key)).entries.find((item) => item.key === `answer-${key}`);
    return { kind: 'answered', text: answer?.text ?? '' };
  }

  /** The planner of an epic above the run, asked with that epic's contract. Its decision goes into the run's handoff. */
  private async epic(run: RunEntity, above: RunEntity[], level: number, question: ChainQuestion): Promise<Reply> {
    const epic = above[level - 1];
    const below = level === 1 ? run : above[level - 2];
    const id = below.taskId ?? below.key;
    const tasks = parseSubtasks(await this.documents.latestBody(epic.key, SUBTASKS_KIND));
    const task = tasks.find((item) => item.id === id) ?? {
      id,
      title: id,
      description: '',
      depends: [],
      files: [],
      proof: '',
      status: 'waiting' as const,
    };
    const contract = (await this.documents.latestBody(epic.key, CONTRACT_KIND)) ?? '';
    const decision = await this.ancestors.askAbout(openedFor(epic, this.clock), task, question.text, contract);
    if (!decision) return { kind: 'none' };
    const handoff = await this.documents.latestBody(run.key, ARTIFACTS.handoff.kind);
    await this.documents.putDocument(run, ARTIFACTS.handoff.kind, mergeHandoff(handoff, question.from, decision));
    return { kind: 'answered', text: decision };
  }

  /**
   * The person who started the run is asked. A subtask's question goes among the questions of its parent, which the
   * person's answer reaches the task from. A run of no parent puts it among its own, as the planner's escalation does.
   */
  private async toStarter(run: RunEntity, parent: RunEntity | null, question: ChainQuestion): Promise<void> {
    const waiting = parent ?? run;
    if (parent) {
      if (parent.status === 'waiting') await this.ancestors.handUp(parent, run.taskId ?? run.key, question.text);
    } else {
      const escalation: PlanChatEntry = {
        key: `escalate-${entryKey(question)}`,
        role: 'planner',
        kind: 'escalation',
        from: question.from,
        text: question.text,
        at: this.clock.iso(),
        state: 'pending',
      };
      await this.chat.appendEntry(run.key, escalation);
      await escalateToPerson(this.documents, run, escalation);
    }
    const fresh = await this.runs.findRun(waiting.key);
    if (fresh?.status === 'waiting')
      await this.runs.release(fresh, { status: 'waiting', facts: { needsAnswers: true } });
  }

  private async levels(run: RunEntity): Promise<Record<string, number[]>> {
    try {
      return JSON.parse((await this.documents.latestBody(run.key, LEVELS_KIND)) ?? '{}') as Record<string, number[]>;
    } catch {
      return {};
    }
  }

  private async remember(run: RunEntity, levels: Record<string, number[]>, key: string, level: number): Promise<void> {
    const done = levels[key] ?? [];
    await this.documents.putDocument(run, LEVELS_KIND, JSON.stringify({ ...levels, [key]: [...done, level] }));
  }
}
