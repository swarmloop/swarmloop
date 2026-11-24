import type { PlanConversation } from '../steps/shared/plan-conversation';
import type { RunEntity } from '../history/entities';
import { DocumentRepository } from '../history/document.repository';
import { PlanChatStore } from '../history/plan-chat.store';
import { repositoryDatabase } from '../history/repository.spec-helpers';
import { RunRepository } from '../history/run.repository';
import { storedState } from '../history/run-state';
import { HopGate } from '../pipeline/hop-gate';
import { PlannerChain } from '../pipeline/planner-chain';
import type { SubtaskPort } from '../pipeline/subtask-port';
import { mayAsk } from '../steps/implement/implement-question';
import { holdServices, seedBacklogTask } from '../steps/shared/question-holds.spec-helpers';

const AT = '2026-01-01T00:00:00.000Z';

/** What the real chain and the real hop gate did with a question that no planner holds back. */
export interface ObservedChain {
  /** The levels that answered one question of a run with no parent, then of a subtask, nearest first. */
  alone: string[];
  task: string[];
  /** The question of a backlog's run, which no level answered, waits for the backlog's planner. */
  backlogStarter: boolean;
  /** A refused start that a planner answered starts again; one that reached the starter ends the drive. */
  refusal: { again: boolean; ends: boolean };
  /** A subtask's code-review may ask its planner. */
  subtaskAsks: boolean;
}

/** The levels a question climbs while each planner answers it, in order, up to the starter. */
async function climb(chain: PlannerChain, run: RunEntity, text: string): Promise<string[]> {
  const levels: string[] = [];
  for (let step = 0; step < 6 && levels.at(-1) !== 'starter'; step++) {
    levels.push((await chain.askUp(run, { from: 'code-review', text }, 0)).asked);
  }
  return levels;
}

/** Runs the real planner chain and the real hop gate over a run alone, a subtask and a backlog's run. */
export async function observeChain(): Promise<ObservedChain> {
  const db = await repositoryDatabase();
  try {
    const runs = db.app.get(RunRepository);
    const documents = db.app.get(DocumentRepository);
    const chat = new PlanChatStore(runs, documents);
    const turns: ({ reply: string } | null)[] = [];
    const conversation = {
      chat,
      clock: { iso: () => AT, now: () => Date.parse(AT) },
      visit: () => {
        const turn = turns.length > 0 ? turns.shift() : { reply: 'It stands.' };
        return Promise.resolve(turn ? { value: turn } : null);
      },
    } as unknown as PlanConversation;
    const chain = new PlannerChain(
      { askAbout: () => Promise.resolve('The epic decides.'), handUp: () => Promise.resolve() },
      conversation,
      documents,
      runs,
      holdServices(db.app, db.clock).holds,
    );
    const epic = await runs.openWaiting('EPIC-1', '/target');
    const task = await runs.openSubtask('EPIC-1-a', epic.id, 'a');
    const alone = await runs.openWaiting('ALONE-1', '/target');
    const backlog = await runs.openWaiting('BACK-1', '/target');
    const levels = { alone: await climb(chain, alone, 'one'), task: await climb(chain, task, 'two') };
    await seedBacklogTask(db.app, 'BACK-1');
    await runs.saveRun({ ...backlog, currentStep: 'implement' });
    turns.push(null);
    await chain.askUp(backlog, { from: 'code-review', text: 'three' }, 0);
    const held = storedState((await runs.findRun('BACK-1'))!).reason?.code === 'ASKS_PLANNER';
    const gate = new HopGate(
      {} as never,
      {} as never,
      runs,
      {} as never,
      { askUp: (run, question, level) => chain.askUp(run, question, level) } as SubtaskPort,
    );
    const refusal = (key: string) => ({
      question: { from: 'code-review', text: `Not started again: ${key}` },
      startLevel: 0,
      message: 'Not started again.',
    });
    const again = await gate.askChain('ALONE-1', refusal('first'));
    turns.push(null);
    const ends = await gate.askChain('ALONE-1', refusal('second'));
    const place = { root: '', env: {} as never };
    const asks = await mayAsk({ ...task, currentStep: 'code-review' }, {} as PlanChatStore, place);
    return {
      ...levels,
      backlogStarter: held,
      refusal: { again: 'again' in again, ends: 'message' in ends },
      subtaskAsks: asks,
    };
  } finally {
    await db.close();
  }
}
