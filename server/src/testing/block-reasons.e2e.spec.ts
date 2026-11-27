import 'reflect-metadata';
import { storeRun } from './store-run.spec-helpers';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { INestApplicationContext } from '@nestjs/common';
import { StepStopped } from '../agent/step-stopped';
import { RunQueriesService } from '../api/run-queries.service';
import { seededBoot } from '../api/runs-boot.spec-helpers';
import { ERROR_CODES } from '../contract/error-codes';
import { REASON } from '../contract/run-state';
import { FakeClock } from '../core/fake-clock.spec-helpers';
import { ownBlockCode } from '../core/pipeline-result';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { writeRunState } from '../history/run-state';
import { errorEnd } from '../steps/step-error-end';
import { checkRepeatedBlock } from '../steps/implement/implement-record';
import { blockedEnd } from '../steps/pipeline/pipeline-result';
import { flakyBlock } from '../steps/pipeline/pipeline-red';
import type { OpenedStep } from '../steps/step-run';
import { RunStateRefresh } from '../steps/shared/run-state-refresh';

/** A block as its writer ends it: the step, the code and the text it gives. */
interface Block {
  step: string;
  code: string;
  text: string;
}

function routed(step: string, result: { route: { to: string; reason?: string; code?: string } }): Block {
  return { step, code: result.route.code ?? '', text: result.route.reason ?? '' };
}

function stopped(): Block {
  const end = errorEnd(new StepStopped(), '10:00', new FakeClock(), { RECONCILE_MS: 1000 });
  return { step: 'implement', code: end?.code ?? '', text: end?.line ?? '' };
}

/** The block an older server stored when a step did not fit its call budget; no step writes it any more. */
const FIT_GATE: Block = { step: 'code-review', code: REASON.didNotFit, text: 'code-review does not fit' };

const WRITERS: [string, () => Block][] = [
  [REASON.stopped, stopped],
  [REASON.didNotFit, () => FIT_GATE],
  [
    REASON.checkFailed,
    () =>
      routed(
        'implement-improve',
        checkRepeatedBlock('10:00', 'implement-improve', new Error('repo: npm test failed again on unchanged files')),
      ),
  ],
  [REASON.ciLogUnavailable, () => routed('pipeline', blockedEnd('a failed job has no log', REASON.ciLogUnavailable))],
  [REASON.ciNotRun, () => routed('pipeline', blockedEnd('CI did not run lint', ERROR_CODES.CI_NOT_RUN))],
  [REASON.ciTimeout, () => routed('pipeline', blockedEnd('lint timed out', REASON.ciTimeout))],
  [ERROR_CODES.TEST_FLAKY, () => routed('pipeline', flakyBlock({ startedAt: '10:00' } as OpenedStep, 'a test'))],
  [REASON.loopLimit, () => ({ step: 'code-review', code: ownBlockCode('code-review'), text: 'blocked' })],
];

let app: INestApplicationContext;
let counter = 0;

beforeAll(async () => {
  app = await seededBoot(await mkdtemp(join(tmpdir(), 'swarmloop-block-reasons-')));
});

afterAll(async () => {
  await app.close();
});

async function view(key: string) {
  const flow = await app.get(RunQueriesService).flow(key);
  return { state: flow.state, sentence: flow.sentence, actions: flow.actions };
}

describe('a block says why by its code, not by its text', () => {
  it.each(WRITERS)(
    'keeps the state, the sentence and the actions of %s when its error is reworded',
    async (code, writer) => {
      const block = writer();
      expect(block.code).toBe(code);
      const key = `proj-reason-${(counter += 1)}`;
      const runs = app.get(RunRepository);
      const run = await runs.begin(key, block.step);
      writeRunState(run, {
        status: 'blocked',
        currentStep: block.step,
        reason: { code: block.code, message: block.text },
      });
      await storeRun(runs, run);
      await app.get(DocumentRepository).putDocument(run, 'error', `${block.text}\n`);
      runs.notify(key);
      await app.get(RunStateRefresh).settled();
      const before = await view(key);

      await app.get(DocumentRepository).putDocument(run, 'error', 'Reworded: nothing here names a reason.\n');
      runs.notify(key);
      await app.get(RunStateRefresh).settled();
      const after = await view(key);

      expect(after).toEqual(before);
      expect(after.state).toBe(code === REASON.stopped ? 'stopped' : 'blocked');
      expect(after.actions.includes('resume')).toBe(true);
    },
  );
});
