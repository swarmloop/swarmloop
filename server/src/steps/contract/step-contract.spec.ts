import { ARTIFACTS } from './artifacts';
import { InputReader } from './input-reader';
import { outputDrafts } from './output-writer';
import { routeToEnd } from './route';
import type { DocumentRepository } from '../../history/document.repository';
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
  it('types the parsed inputs, null for an optional one', async () => {
    const spec = {
      requirements: { artifact: ARTIFACTS.requirements, need: 'run' },
      questions: { artifact: ARTIFACTS.questions, need: 'optional' },
    } satisfies InputSpec;
    const need: InputNeed = spec.questions.need;
    const documents = { latestBody: async (_key: string, kind: string) => (kind === 'requirements' ? 'text' : null) };
    const input: StepInput<typeof spec> = await new InputReader(documents as DocumentRepository).read('K', spec);
    expect([input.questions, need]).toEqual([null, 'optional']);
    expect(Object.keys(spec)).toEqual(['requirements', 'questions']);
  });

  it('describes a result with its route, outputs, issues and failure', () => {
    const issue: Issue = { id: '1', source: 'review', title: 'fix', body: 'details' };
    const error: StepFailure = { code: 'x', message: 'boom' };
    const profile: AgentProfile = {
      runtime: 'cursor',
      model: 'm',
      mode: 'agent',
      tools: 'write',
      timeLimitMs: 1,
      session: 'resume',
    };
    const output: ArtifactValue = { artifact: ARTIFACTS.requirements, value: 'text' };
    const result: StepResult = {
      route: { to: 'return', step: 'implement', issues: [issue] },
      summary: 'returned',
      outputs: [output],
    };
    expect([result.route.to, error.code, profile.session]).toEqual(['return', 'x', 'resume']);
    expect(routeToEnd(result.route)).toEqual({ outcome: 'waiting', moveTo: 'implement', exitCode: 0 });
    expect(outputDrafts('requirements', [ARTIFACTS.requirements], result.outputs)).toEqual([
      { kind: 'requirements', fileName: '', body: 'text' },
    ]);
  });

  it('types the research result as an output of its own kind', () => {
    const output: ArtifactValue = {
      artifact: ARTIFACTS.researchResult,
      value: { summary: ['why'], questions: [], impact: [] },
    };
    expect(output.artifact.kind).toBe('research_result');
    expect(outputDrafts('research', [ARTIFACTS.researchResult], [output])).toEqual([
      { kind: 'research_result', fileName: '', body: '{"summary":["why"],"questions":[],"impact":[]}\n' },
    ]);
  });
});
