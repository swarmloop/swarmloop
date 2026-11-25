import type { StepName } from '../contract/steps';
import type { StepOptions } from '../core/pipeline-result';
import { HostUnavailable } from '../core/swarmloop-error';
import type { RunRepository } from '../history/run.repository';
import type { AdmittedStart, AgentDoor } from '../steps/shared/agent-door';
import type { ChainRefusal } from '../steps/shared/start-refused';
import type { RunGuards } from './run-guards';
import type { StartGate } from './start-gate';
import type { SubtaskPort } from './subtask-port';

/** What the driver does with a refused start once the chain was asked. */
type Asked = { again: StepOptions } | { message: string };

/** What belongs to a hop: the gate's word before a step starts, the workspace check, and asking up the chain. */
export class HopGate {
  constructor(
    private readonly gate: StartGate,
    private readonly guards: RunGuards,
    private readonly runs: RunRepository,
    private readonly door: AgentDoor,
    private readonly subtasks?: SubtaskPort,
  ) {}

  /**
   * The gate's word before a step starts, on every hop: the start the hop goes on with, the options of a start that a
   * planner's answer made possible, or the message that ends the drive. A refused start asks the chain, and the run
   * left waiting for the person ends the drive.
   */
  async passGate(
    key: string,
    step: StepName,
    options: StepOptions,
  ): Promise<{ start: AdmittedStart } | { again: StepOptions } | { message: string }> {
    const admission = await this.gate.admit(key, step, options);
    if (admission.kind === 'blocked') return { message: admission.message };
    if (admission.kind === 'admitted') {
      const unfit = await this.guards.workspaceStop(key, step);
      return unfit ? { message: unfit } : { start: admission.start };
    }
    return this.askChain(key, admission);
  }

  /** Asks the planners' chain the question of a refused start: it goes on from the answer, or ends with the line. */
  async askChain(key: string, refusal: ChainRefusal): Promise<Asked> {
    const run = await this.runs.findRun(key);
    let asked;
    try {
      asked = run ? await this.subtasks?.askUp(run, refusal.question, refusal.startLevel) : undefined;
    } catch (error) {
      // A model host that does not answer is no reply: the refusal keeps its wait, and the resume asks again.
      if (error instanceof HostUnavailable) return { message: error.message };
      throw error;
    }
    return asked && asked.answer !== null
      ? { again: { auto: true, startBy: 'planner', level: asked.level } }
      : { message: refusal.message };
  }

  /** Called once the step is open: records how the visit was started, then wakes the parent as the first hop asked. */
  opening(key: string, step: StepName, start: AdmittedStart, options: StepOptions): () => Promise<void> {
    return async () => {
      await this.door.noteStep(key, step, start, options);
      await options.opened?.();
    };
  }
}
