import { Injectable } from '@nestjs/common';
import { isRunAction } from '../../../agent-result/definitions/backlog-turn';
import type { BacklogTurnResult } from '../../../agent-result/definitions/backlog-turn';
import { BacklogChatRepository } from '../../../history/backlog-chat.repository';
import type { BacklogTaskRecord } from '../../../history/backlog-writers';
import { BacklogRepository } from '../../../history/backlog.repository';
import type { Tie } from '../../../history/agent-call';
import { RunRepository } from '../../../history/run.repository';

/** The facts of an event that name a task by its slug, and those that name a run by its key. */
const EVENT_TASK_FACTS = ['slug', 'task'];
const EVENT_RUN_FACTS = ['runKey', 'endRun', 'run'];

/** The task slugs and run keys a turn names, in the order named. */
interface Names {
  tasks: string[];
  runs: string[];
}

function addAll(into: string[], values: (string | undefined)[]): void {
  for (const value of values) if (value) into.push(value);
}

/** What the turn's actions name: a command to a run names its run; any other action names its task. */
function namesOfActions(result: BacklogTurnResult): Names {
  const names: Names = { tasks: [], runs: [] };
  for (const action of result.actions) {
    if (isRunAction(action)) addAll(names.runs, [action.run]);
    else if ('task' in action) addAll(names.tasks, [action.task]);
  }
  return names;
}

/** What the turn's events name through their facts. */
function namesOfEvents(events: { facts: Record<string, string> }[]): Names {
  const names: Names = { tasks: [], runs: [] };
  for (const { facts } of events) {
    addAll(
      names.tasks,
      EVENT_TASK_FACTS.map((fact) => facts[fact]),
    );
    addAll(
      names.runs,
      EVENT_RUN_FACTS.map((fact) => facts[fact]),
    );
  }
  return names;
}

/** The ties of a backlog planner's turn: the tasks, runs and epics its events and actions name, never the backlog alone. */
@Injectable()
export class TurnTies {
  constructor(
    private readonly backlogs: BacklogRepository,
    private readonly chat: BacklogChatRepository,
    private readonly runs: RunRepository,
  ) {}

  /**
   * Reads the turn's events, which are known before the launch, and returns the function that gives the ties once the
   * result's actions are known. A turn that names none is tied to the first running task of the backlog in its order,
   * else the first waiting one, and that tie is marked general; with neither, it has no tie.
   */
  async of(backlogId: number, turnKey: string): Promise<(value: unknown) => Promise<Tie[]>> {
    const { events } = await this.chat.itemsOfTurn(turnKey);
    const named = namesOfEvents(events);
    return async (value) => {
      const tasks = await this.backlogs.tasks(backlogId);
      const fromActions = namesOfActions(value as BacklogTurnResult);
      const ties = new Map<string, Tie>();
      const add = (tie: Tie | null): void => {
        const id = tie ? (tie.task ?? tie.run ?? tie.epic) : undefined;
        if (tie && id !== undefined && !ties.has(id)) ties.set(id, tie);
      };
      for (const slug of [...named.tasks, ...fromActions.tasks]) add(await this.ofTask(tasks, slug));
      for (const key of [...named.runs, ...fromActions.runs]) add(await this.ofRun(tasks, key));
      if (ties.size > 0) return [...ties.values()];
      const task = tasks.find((row) => row.status === 'running') ?? tasks.find((row) => row.status === 'waiting');
      return task ? [{ task: task.slug, ...(task.runKey ? { run: task.runKey } : {}), general: true }] : [];
    };
  }

  private async ofTask(tasks: BacklogTaskRecord[], slug: string): Promise<Tie | null> {
    const task = tasks.find((row) => row.slug === slug);
    if (!task) return null;
    const run = task.runKey ? await this.ofRun(tasks, task.runKey) : null;
    return {
      task: task.slug,
      ...(run?.run ? { run: run.run } : {}),
      ...(run?.epic ? { epic: run.epic } : {}),
      general: false,
    };
  }

  /** A run key ties its run, the task that holds it or its epic, and its epic: the parent's key for a part, its own for an epic's parent. */
  private async ofRun(tasks: BacklogTaskRecord[], key: string): Promise<Tie | null> {
    const run = await this.runs.findRun(key);
    const parentId = run?.parentRunId ?? null;
    const parent = parentId === null ? null : await this.runs.findById(parentId);
    const epic = parent?.key ?? (run && (await this.runs.children(run)).length > 0 ? run.key : undefined);
    const task = tasks.find((row) => row.runKey === key || (epic !== undefined && row.runKey === epic));
    if (!run && !task) return null;
    return { ...(task ? { task: task.slug } : {}), run: key, ...(epic ? { epic } : {}), general: false };
  }
}
