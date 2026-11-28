import { Injectable } from '@nestjs/common';
import type { BacklogEventKind, MergeMode, MilestoneStatus, RequirementStatus } from '../../../contract/backlog';
import type { MessageAuthor } from '../../../contract/backlog-chat';
import { SwarmloopError } from '../../../core/swarmloop-error';
import { type Subtask, SUBTASKS_KIND, parseSubtasks } from '../../../contract/subtask';
import { BacklogChatRepository } from '../../../history/backlog-chat.repository';
import { BacklogRepository, type BacklogTaskRecord } from '../../../history/backlog.repository';
import type { BacklogEventRecord, MilestoneRecord, RequirementRecord } from '../../../history/backlog-writers';
import { DocumentRepository } from '../../../history/document.repository';
import { RunRepository } from '../../../history/run.repository';
import { storedState } from '../../../history/run-state';
import { backlogTasks, type RunFacts } from '../task-readiness';
import { EventFacts } from './event-facts';
import { RunReasons } from './run-reason';

/** How many of the newest messages a turn reads. */
const TURN_MESSAGES = 20;

/** How many of the newest decisions a turn's brief shows. */
const TURN_DECISIONS = 20;

export interface DecisionState {
  id: number;
  text: string;
  who: string;
  at: string;
}

interface RequirementState {
  ref: string;
  text: string;
  status: RequirementStatus;
}

interface SubtaskState {
  id: string;
  title: string;
  status: Subtask['status'];
  depends: string[];
  files: string[];
}

export interface TaskState {
  slug: string;
  title: string;
  description: string;
  status: Subtask['status'];
  /** The revision a change of the task names; a change of a task that moved since is refused. */
  revision: number;
  /** What the task waits for, in the scheduler's words. */
  wait: string;
  runKey: string | null;
  repositories: string[];
  covers: string[];
  depends: string[];
  files: string[];
  fixesMain: string | null;
  /** Why the task's run failed or is blocked, or null when it is neither or gives no reason. */
  reason: string | null;
  /** The tasks of a run that split, read from the run's stored task list. */
  subtasks: SubtaskState[];
}

interface MilestoneState {
  number: number;
  title: string;
  goal: string;
  status: MilestoneStatus;
  requirements: RequirementState[];
  tasks: TaskState[];
}

interface TurnEvent {
  kind: BacklogEventKind;
  at: string;
  facts: Record<string, string>;
}

/** Everything a planner turn knows, read from the database at the start of the turn. */
export interface TurnState {
  backlog: { id: number; name: string; repositories: string[]; mergeMode: MergeMode; paused: boolean };
  active: MilestoneState | null;
  planned: MilestoneState[];
  /** The tasks that belong to no milestone. */
  items: TaskState[];
  /** The newest decisions the brief shows, oldest first. */
  decisions: DecisionState[];
  /** How many decisions come before the ones shown. */
  olderDecisions: number;
  /** Every decision, newest first, for the file. */
  allDecisions: DecisionState[];
  messages: { author: MessageAuthor; text: string; at: string }[];
  /** How many messages come before the ones shown. */
  olderMessages: number;
  /** The messages this turn holds, oldest first. */
  messagesOfTurn: { author: MessageAuthor; text: string; at: string }[];
  /** The state the chat saw at its last turn, as stored, or null. */
  lastSeen: string | null;
  events: TurnEvent[];
}

/** Rebuilds the planner's state for one turn from the database: never from the whole chat, never from a run's chat. */
@Injectable()
export class BacklogTurnState {
  constructor(
    private readonly backlogs: BacklogRepository,
    private readonly chat: BacklogChatRepository,
    private readonly runs: RunRepository,
    private readonly documents: DocumentRepository,
    private readonly facts: EventFacts,
    private readonly reasons: RunReasons,
  ) {}

  async read(backlogName: string, turnKey: string): Promise<TurnState> {
    const backlog = await this.backlogs.findBacklog(backlogName);
    if (backlog === null) throw new SwarmloopError(`no backlog ${backlogName}`);
    const id = backlog.id as number;
    const [milestones, requirements, records, decisions] = await Promise.all([
      this.backlogs.milestones(id),
      this.backlogs.requirements(id),
      this.backlogs.tasks(id),
      this.backlogs.decisions(id),
    ]);
    const tasks = await this.taskStates(milestones, records);
    const recent = await this.chat.lastMessages(id, TURN_MESSAGES);
    const held = await this.chat.itemsOfTurn(turnKey);
    const allDecisions = decisions
      .map(({ id: decisionId, text, who, createdAt }) => ({ id: decisionId as number, text, who, at: createdAt }))
      .reverse();
    const milestoneState = (milestone: MilestoneRecord): MilestoneState => ({
      number: milestone.number,
      title: milestone.title,
      goal: milestone.goal,
      status: milestone.status,
      requirements: requirements
        .filter((requirement: RequirementRecord) => requirement.milestoneId === milestone.id)
        .map(({ ref, text, status }) => ({ ref, text, status })),
      tasks: tasks.filter((task) => task.milestoneId === milestone.id).map((task) => task.state),
    });
    return {
      backlog: {
        id,
        name: backlog.name,
        repositories: backlog.repositories,
        mergeMode: backlog.mergeMode,
        paused: backlog.paused,
      },
      active: milestones.filter((milestone) => milestone.status === 'active').map(milestoneState)[0] ?? null,
      planned: milestones
        .filter((milestone) => milestone.status === 'proposed' || milestone.status === 'queued')
        .map(milestoneState),
      items: tasks.filter((task) => task.milestoneId === null).map((task) => task.state),
      decisions: allDecisions.slice(0, TURN_DECISIONS).reverse(),
      olderDecisions: Math.max(0, allDecisions.length - TURN_DECISIONS),
      allDecisions,
      messages: recent.messages.map(({ author, text, createdAt }) => ({ author, text, at: createdAt })),
      olderMessages: recent.older,
      messagesOfTurn: held.messages.map(({ author, text, createdAt }) => ({ author, text, at: createdAt })),
      lastSeen: await this.chat.lastSeenState(id),
      events: await this.factsOf(backlog.owner, held.events, turnKey),
    };
  }

  /** The given events of the turn with their facts, read the way the brief reads its events: a run's whole texts land in the turn's folder. */
  async eventsOf(backlogName: string, turnKey: string, events: BacklogEventRecord[]): Promise<TurnEvent[]> {
    const backlog = await this.backlogs.findBacklog(backlogName);
    if (backlog === null) throw new SwarmloopError(`no backlog ${backlogName}`);
    return this.factsOf(backlog.owner, events, turnKey);
  }

  private async factsOf(owner: string, records: BacklogEventRecord[], turnKey: string): Promise<TurnEvent[]> {
    const events: TurnEvent[] = [];
    for (const event of records) {
      events.push({ kind: event.kind, at: event.createdAt, facts: await this.facts.of(owner, event, turnKey) });
    }
    return events;
  }

  /** Every task with its shown status, the way the scheduler reads it, and its subtasks when its run split. */
  private async taskStates(milestones: MilestoneRecord[], records: BacklogTaskRecord[]) {
    const active = new Set(milestones.filter((milestone) => milestone.status === 'active').map((m) => m.id as number));
    const runFacts = new Map<string, RunFacts>();
    const reasons = new Map<string, string | null>();
    for (const record of records) {
      const run = record.runKey === null ? null : await this.runs.findRun(record.runKey);
      if (!run) continue;
      runFacts.set(run.key, { state: storedState(run).state, currentStep: run.currentStep });
      reasons.set(run.key, await this.reasons.of(run));
    }
    const shown = new Map(backlogTasks(records, active, runFacts).map((task) => [task.id, task.status]));
    const states = [];
    for (const record of records) {
      const state: TaskState = {
        slug: record.slug,
        title: record.title,
        description: record.description,
        status: shown.get(record.slug) ?? record.status,
        revision: record.revision ?? 0,
        wait: record.note,
        runKey: record.runKey,
        repositories: record.repositories,
        covers: record.covers,
        depends: record.depends,
        files: record.files,
        fixesMain: record.fixesMain,
        reason: (record.runKey && reasons.get(record.runKey)) || null,
        subtasks: await this.subtasksOf(record.runKey),
      };
      states.push({ milestoneId: record.milestoneId, state });
    }
    return states;
  }

  private async subtasksOf(runKey: string | null): Promise<SubtaskState[]> {
    if (runKey === null) return [];
    const stored = parseSubtasks(await this.documents.latestBody(runKey, SUBTASKS_KIND));
    return stored.map(({ id, title, status, depends, files }) => ({ id, title, status, depends, files }));
  }
}
