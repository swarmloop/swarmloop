import { newestPerWorkflow } from './check-status';

interface Row {
  id: number;
  workflow: string;
  number: number;
}

const workflowOf = (row: Row): string => row.workflow;
const numberOf = (row: Row): number => row.number;

describe('newestPerWorkflow', () => {
  it('keeps the highest number of each workflow, in the order of the rows', () => {
    const rows = [
      { id: 1, workflow: 'ci', number: 3 },
      { id: 2, workflow: 'lint', number: 1 },
      { id: 3, workflow: 'ci', number: 2 },
      { id: 4, workflow: 'lint', number: 2 },
    ];
    expect(newestPerWorkflow(rows, workflowOf, numberOf).map((row) => row.id)).toEqual([1, 4]);
  });

  it('keeps a newer row that comes after an older one', () => {
    const rows = [
      { id: 1, workflow: 'ci', number: 1 },
      { id: 2, workflow: 'ci', number: 2 },
    ];
    expect(newestPerWorkflow(rows, workflowOf, numberOf)).toEqual([rows[1]]);
  });

  it('returns a single row unchanged', () => {
    const rows = [{ id: 1, workflow: 'ci', number: 1 }];
    expect(newestPerWorkflow(rows, workflowOf, numberOf)).toEqual(rows);
  });
});
