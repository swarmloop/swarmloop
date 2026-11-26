import { checkOutputNaming, ciJobLogNaming } from '../../testing/outside-red.spec-helpers';
import { failedJobs } from '../pipeline/failed-jobs';
import { outsideQuestion, outsideRed } from './outside-red';

describe('outsideRed', () => {
  it('is null when no log names a test file', () => {
    expect(outsideRed(['Error: build failed in src/a.ts'], ['src/a.ts'])).toBeNull();
  });

  it('is null when a named test is a changed file, equal or with the runner directories in front', () => {
    expect(outsideRed([checkOutputNaming('src/a.test.ts')], ['src/a.test.ts'])).toBeNull();
    expect(outsideRed([checkOutputNaming('/app/server/src/a.test.ts')], ['server/src/a.test.ts'])).toBeNull();
    expect(outsideRed([checkOutputNaming('a.test.ts')], ['server/src/a.test.ts'])).toBeNull();
  });

  it('is null when any one of several named tests is changed', () => {
    const logs = [checkOutputNaming('src/a.test.ts'), ciJobLogNaming('src/b.test.ts')];

    expect(outsideRed(logs, ['src/b.test.ts'])).toBeNull();
  });

  it('gives the named tests when the change touches none of them', () => {
    const logs = [checkOutputNaming('src/a.test.ts'), ciJobLogNaming('src/b.test.ts')];

    expect(outsideRed(logs, ['src/c.ts', 'src/xa.test.ts'])).toEqual(['src/a.test.ts', 'src/b.test.ts']);
  });

  it('reads the helpers as logs that name their file', () => {
    expect(outsideRed([checkOutputNaming('x/y.spec.ts')], [])).toEqual(['x/y.spec.ts']);
    const [job] = failedJobs(ciJobLogNaming('x/z.spec.ts', 'server-test'));
    expect(job.job).toBe('server-test');
    expect(outsideRed([job.text], [])).toEqual(['x/z.spec.ts']);
  });
});

describe('outsideQuestion', () => {
  it('names the jobs, the tests, the logs and the changed files', () => {
    const text = outsideQuestion({
      what: ['server-test'],
      tests: ['src/a.test.ts'],
      logs: ['/briefs/ci-1.log'],
      changed: ['src/c.ts'],
    });

    for (const part of ['server-test', 'src/a.test.ts', '/briefs/ci-1.log', 'src/c.ts', 'replay', 'up the chain']) {
      expect(text).toContain(part);
    }
  });
});
