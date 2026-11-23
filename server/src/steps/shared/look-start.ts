import type { StartBy, StepOptions } from '../../core/pipeline-result';
import type { StepName } from '../../contract/steps';

/** Who starts a visit of the planner, and for a visit that runs inside a step, which one and with what prompt. */
export interface LookStart {
  by: StartBy;
  level?: number | null;
  visitOf?: StepName;
  prompt?: string;
}

/** The start of a planner visit that runs inside the implement visit with these options. */
export function implementStart(options: StepOptions): LookStart {
  return {
    by: options.startBy ?? 'person',
    level: options.level ?? null,
    visitOf: 'implement',
    prompt: options.prompt ?? '',
  };
}

/** The start and input the door is told of a start of the run's own planner. */
interface PlannerStart {
  by: StartBy;
  level?: number | null;
  plannerLevel: number;
  input: { visitOf?: StepName; prompt?: string; texts: string[] };
}

/** What the door is told of a start of the run's own planner: who starts it and the input it runs on. A start with none is the machine's. */
export function plannerStart(start: LookStart | undefined, texts: string[]): PlannerStart {
  const { by, level, visitOf, prompt } = start ?? { by: 'machine' as const };
  return { by, level, plannerLevel: 0, input: { visitOf, prompt, texts } };
}
