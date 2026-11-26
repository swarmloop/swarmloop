import type { RunEntity } from '../../history/entities';
import type { ImplementationResult } from '../../agent-result/definitions/implementation';
import type { StarterExchange } from '../shared/starter-exchange';
import { implementErrors } from './implement-asks';

const exchange = { check: () => [] as string[] } as unknown as StarterExchange;
const needOnly: ImplementationResult = {
  implementation: [],
  summary: [],
  needs: [{ id: 'none', what: 'A test outside fails.' }],
};
const run = { key: 'PROJ-1', taskId: null, parentRunId: null } as unknown as RunEntity;
const errors = (mayQuestion: boolean) => implementErrors(run, needOnly, mayQuestion, exchange, null);

describe('implementErrors', () => {
  it('lets a need-only answer of a run that is not a subtask through when it may ask', () => {
    expect(errors(true)).toEqual([]);
  });

  it('refuses it when there is no planner to ask', () => {
    expect(errors(false)).toEqual(['implementation: must list what you changed']);
  });
});
