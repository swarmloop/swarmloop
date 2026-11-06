import { ARTIFACTS } from './artifacts';
import type {
  AgentProfile,
  ArtifactValue,
  InputNeed,
  InputSpec,
  Issue,
  StepFailure,
  StepInput,
  StepResult,
} from './step-contract';

describe('step contract', () => {
  it('types the parsed inputs, null for an optional one', () => {
    const spec = {
      requirements: { artifact: ARTIFACTS.requirements, need: 'run' },
      questions: { artifact: ARTIFACTS.questions, need: 'optional' },
    } satisfies InputSpec;
    const need: InputNeed = spec.questions.need;
    const input: StepInput<typeof spec> = { requirements: 'text', questions: null };
    expect([input.questions, need]).toEqual([null, 'optional']);
    expect(Object.keys(spec)).toEqual(['requirements', 'questions']);
  });

  it('describes a result with its route, outputs, issues and failure', () => {
    const issue: Issue = { id: '1', source: 'review', title: 'fix', body: 'details' };
    const error: StepFailure = { code: 'x', message: 'boom' };
    const profile: AgentProfile = { runtime: 'cursor', model: 'm', mode: 'agent', timeLimitMs: 1, session: 'resume' };
    const output: ArtifactValue = { artifact: ARTIFACTS.requirements, value: 'text' };
    const result: StepResult = {
      route: { to: 'return', step: 'implement', issues: [issue] },
      summary: 'returned',
      outputs: [output],
    };
    expect([result.route.to, error.code, profile.session]).toEqual(['return', 'x', 'resume']);
  });
});
