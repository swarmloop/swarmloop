import { storeRun } from '../../../testing/store-run.spec-helpers';
import { readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { BacklogEventKind } from '../../../contract/backlog';
import { checkOutputPath } from '../../../core/check-output';
import { runLogPath } from '../../../core/run-logs';
import { CheckCommandRepository } from '../../../history/check-command.repository';
import { attachmentsDir } from '../../../history/run-paths';
import { repositoryVisit } from '../../../history/repository.spec-helpers';
import { VisitRepository } from '../../../history/visit.repository';
import { ARTIFACTS } from '../../../steps/contract/artifacts';
import { mergeHandoff } from '../../../steps/shared/handoff';
import type { EventFacts } from './event-facts';
import { plannerFacts } from './planner-facts.spec-helpers';

type Harness = Awaited<ReturnType<typeof plannerFacts>>;

async function withFacts(body: (h: Harness, facts: EventFacts) => Promise<void>): Promise<void> {
  const h = await plannerFacts();
  try {
    await body(h, h.eventFacts());
  } finally {
    await h.close();
  }
}

async function eventOf(h: Harness, backlogId: number, kind: BacklogEventKind, facts: Record<string, string>) {
  await h.addEvent(backlogId, `${kind}:${JSON.stringify(facts)}`, kind, facts);
  return (await h.backlogs.events(backlogId, 1))[0];
}

describe('EventFacts', () => {
  it('gives a run question what is decided and each side', () =>
    withFacts(async (h, facts) => {
      const id = await h.addBacklog();
      const parts = [
        {
          question: 'Q1',
          parts: {
            decide: 'Is the review right?',
            sides: [
              { who: 'quality', text: 'it is\nslow' },
              { who: 'implement', text: 'no' },
            ],
            full: '',
            askedAt: '',
          },
        },
      ];
      await h.addRun('a-1', { question_parts: JSON.stringify(parts) });
      const event = await eventOf(h, id, 'run-needs-person', { slug: 'a', runKey: 'a-1' });

      expect(await facts.of('owner', event, 'turn-1')).toMatchObject({
        slug: 'a',
        question: 'Is the review right?',
        sides: 'quality: it is slow\nimplement: no',
      });
    }));

  it('gives a question the planner holds the decide line and sides of that one question only', () =>
    withFacts(async (h, facts) => {
      const id = await h.addBacklog();
      const stored = (question: string, who: string) => ({
        question,
        parts: { decide: `Decide ${question}`, sides: [{ who, text: `${who} says` }], full: '', askedAt: '' },
      });
      await h.addRun('a-1', { question_parts: JSON.stringify([stored('Q1', 'quality'), stored('Q2', 'security')]) });
      const event = await eventOf(h, id, 'run-asks-planner', {
        slug: 'a',
        runKey: 'a-1',
        questionId: 'Q2',
        question: 'Q2',
      });

      expect(await facts.of('owner', event, 'turn-1')).toMatchObject({
        questionId: 'Q2',
        question: 'Decide Q2',
        sides: 'security: security says',
      });
    }));

  it('falls back to the questions document, and says so when the run stored none', () =>
    withFacts(async (h, facts) => {
      const id = await h.addBacklog();
      await h.addRun('a-1', { questions: 'Which library?' });
      await h.addRun('b-1');
      const asked = await eventOf(h, id, 'run-needs-person', { runKey: 'a-1' });
      const none = await eventOf(h, id, 'run-needs-person', { runKey: 'b-1' });

      expect((await facts.of('owner', asked, 'turn-1')).question).toBe('Which library?');
      expect((await facts.of('owner', none, 'turn-1')).note).toBe('the run has no stored question');
    }));

  it('gives a merged task its report, its requirement statuses and its commit note', () =>
    withFacts(async (h, facts) => {
      const id = await h.addBacklog();
      await h.addTask(id, 'a', { runKey: 'a-1' });
      const marks = {
        decision: 'ok',
        review: 'requirements',
        summary: [],
        requirements: [{ id: 'R1', status: 'met', note: 'in x.ts' }],
      };
      await h.addRun('a-1', {
        review_report: 'Ready to merge',
        [ARTIFACTS.reviewRequirementsResult.kind]: JSON.stringify(marks),
        commit: '- added x.ts\n',
      });
      const event = await eventOf(h, id, 'task-merged', { slug: 'a' });

      expect(await facts.of('owner', event, 'turn-1')).toMatchObject({
        slug: 'a',
        report: 'Ready to merge',
        requirements: 'R1 is met: in x.ts',
        diff: '- added x.ts',
      });
    }));

  it('names the files a merged backlog task changed outside its files and its not built lines', () =>
    withFacts(async (h, facts) => {
      const id = await h.addBacklog();
      await h.addTask(id, 'a', { runKey: 'a-1', files: ['src/a.ts'] });
      await h.addRun('a-1', {
        [ARTIFACTS.mergedFiles.kind]: 'src/a.ts\nsrc/other.spec.ts',
        [ARTIFACTS.handoff.kind]: mergeHandoff(null, 'implement', '- not built: docs - out of time'),
      });
      const event = await eventOf(h, id, 'task-merged', { slug: 'a' });

      const marks = (await facts.of('owner', event, 'turn-1')).marks ?? '';

      expect(marks).toContain('not built: docs - out of time');
      expect(marks).toContain('its merge request changed files outside its plan: src/other.spec.ts');
    }));

  it("reads the files outside the plan from the commit paths and the run's plan when the task lists none, and every unmet review item", () =>
    withFacts(async (h, facts) => {
      const id = await h.addBacklog();
      await h.addTask(id, 'a', { runKey: 'a-1' });
      const plan = { summary: [], plan: ['Do a - files: src/a.ts - proof: a.spec.ts'], questions: [] };
      const review = {
        decision: 'ok',
        review: 'requirements',
        summary: [],
        requirements: [
          { id: 'R1', status: 'met', note: 'in a.ts' },
          { id: 'R2', status: 'partial', note: 'half done' },
        ],
      };
      await h.addRun('a-1', {
        [ARTIFACTS.planResult.kind]: ARTIFACTS.planResult.format(plan as never),
        [ARTIFACTS.commit.kind]: 'web\tsrc/a.ts\nweb\tsrc/b.ts\n',
        [ARTIFACTS.reviewRequirementsResult.kind]: JSON.stringify(review),
      });
      const event = await eventOf(h, id, 'task-merged', { slug: 'a' });

      const marks = (await facts.of('owner', event, 'turn-1')).marks ?? '';

      expect(marks).toContain('its merge request changed files outside its plan: src/b.ts');
      expect(marks).toContain('requirement R2 is partial: half done');
      expect(marks).not.toContain('R1');
    }));

  it('says why a merged task has no facts to read', () =>
    withFacts(async (h, facts) => {
      const id = await h.addBacklog();
      await h.addTask(id, 'a');
      const event = await eventOf(h, id, 'task-merged', { slug: 'a' });

      expect((await facts.of('owner', event, 'turn-1')).note).toBe('the task has no run');
    }));

  it('gives a red main its failing job and the tail of its log, and says how much is left out and where the whole is', () =>
    withFacts(async (h, facts) => {
      const id = await h.addBacklog();
      h.redMain('web', Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join('\n'));
      const event = await eventOf(h, id, 'main-red', { repository: 'web', head: 'h1' });

      const given = await facts.of('owner', event, 'turn-1');

      expect(given.job).toBe('unit tests');
      const lines = (given.log ?? '').split('\n');
      expect(lines[0]).toBe('40 earlier lines are left out; the whole text is at https://backlog.example/acme/jobs/9.');
      expect(lines).toHaveLength(61);
      expect(lines.at(-1)).toBe('line 100');
    }));

  it('keeps a short log whole', () =>
    withFacts(async (h, facts) => {
      const id = await h.addBacklog();
      h.redMain('web', 'boom\n');
      const event = await eventOf(h, id, 'main-red', { repository: 'web', head: 'h1' });

      expect((await facts.of('owner', event, 'turn-1')).log).toBe('boom');
    }));

  it('turns a read that fails into a note instead of failing the turn', () =>
    withFacts(async (h, facts) => {
      const id = await h.addBacklog();
      const event = await eventOf(h, id, 'main-red', { repository: 'unknown', head: 'h1' });

      expect((await facts.of('owner', event, 'turn-1')).note).toMatch(/^its facts could not be read: /);
    }));

  it('passes the person message and the planner reply of a run chat through', () =>
    withFacts(async (h, facts) => {
      const id = await h.addBacklog();
      const event = await eventOf(h, id, 'run-chat', { slug: 'a', message: 'use x', reply: 'done' });

      expect(await facts.of('owner', event, 'turn-1')).toEqual({ slug: 'a', message: 'use x', reply: 'done' });
    }));
});

const hundred = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join('\n');
const WHOLE = '/work/brief/attachments';

/** A run on `step`, with a finished visit of that step that stored `documents`. Returns the visit's stat. */
async function visited(h: Harness, key: string, step: string, documents: Record<string, string> = {}) {
  await h.addRun(key);
  const run = (await h.runs.findRun(key)) as NonNullable<Awaited<ReturnType<typeof h.runs.findRun>>>;
  run.currentStep = step;
  await storeRun(h.runs, run);
  const visits = h.app.get(VisitRepository);
  let stat = await visits.finishVisit(run, { ...repositoryVisit(), step, document: null });
  for (const [kind, body] of Object.entries(documents)) {
    stat = await visits.finishVisit(run, {
      ...repositoryVisit(),
      step,
      document: { kind, fileName: `${kind}.md`, body },
    });
  }
  return { run, stat, visits };
}

describe('EventFacts of a run that ended', () => {
  it('names the step a failed run stopped at and the error its window shows, masked, and leaves out an error of an older visit', () =>
    withFacts(async (h, facts) => {
      const id = await h.addBacklog();
      const { run, visits } = await visited(h, 'run-1', 'implement', { error: 'boom\nBearer abc123secret' });
      const event = await eventOf(h, id, 'run-needs-person', { runKey: 'run-1', state: 'failed', reason: '' });

      const given = await facts.of('owner', event, 'turn-1');

      expect(given.step).toBe('implement');
      expect(given.error).toBe('boom\nBearer ***');
      expect(given.part).toBeUndefined();

      await visits.finishVisit(run, { ...repositoryVisit(), step: 'implement', document: null });
      expect((await facts.of('owner', event, 'turn-1')).error).toBeUndefined();
    }));

  it('gives each failed check command of the latest checks visit its last lines, and says how much is left out and where the whole is', () =>
    withFacts(async (h, facts) => {
      const id = await h.addBacklog();
      const { run } = await visited(h, 'run-1', 'checks');
      const commands = h.app.get(CheckCommandRepository);
      const row = { runId: run.id, attemptId: 'att-2', repo: 'web' };
      await commands.add({
        ...row,
        command: 'npm run lint',
        name: 'lint',
        commandIndex: 0,
        status: 'failed',
        exitCode: 1,
      });
      await commands.add({ ...row, command: 'npm run build', commandIndex: 1, status: 'done', exitCode: 0 });
      await commands.add({ ...row, command: 'npm test', commandIndex: 2, status: 'done', exitCode: 2 });
      for (const [index, text] of [hundred, 'fine', 'short failure'].entries()) {
        writeFileSync(checkOutputPath(h.root, 'run-1', 'checks', 'att-2', index), text);
      }
      const event = await eventOf(h, id, 'run-needs-person', { runKey: 'run-1', state: 'failed', reason: '' });

      const given = await facts.of('owner', event, 'turn-1');

      const entries = (given.checks ?? '').split('\n\n');
      expect(entries).toHaveLength(2);
      const lint = entries[0].split('\n');
      expect(lint[0]).toBe('web: lint');
      expect(lint[1]).toBe(`40 earlier lines are left out; the whole text is in ${WHOLE}/run-1-checks-1.txt.`);
      expect(lint.at(-1)).toBe('line 100');
      expect(entries[1]).toBe('web: npm test\nshort failure');
      expect(readFileSync(join(attachmentsDir(h.config, 'turn-1'), 'run-1-checks-1.txt'), 'utf8')).toBe(hundred);
      expect(statSync(join(attachmentsDir(h.config, 'turn-1'), 'run-1-checks-1.txt')).mode & 0o777).toBe(0o644);
    }));

  it('gives each failed CI job its log tail with the cut note, and the block of a job whose trace was not saved', () =>
    withFacts(async (h, facts) => {
      const id = await h.addBacklog();
      const report = [
        'result: fail\nproject: acme/web\npipeline: 7\njob: unit\nstage: test\n\nsummary of unit',
        'project: acme/web\npipeline: 7\njob: lint\nstage: test\n\nlint broke',
      ].join('\n\n');
      const { stat, visits } = await visited(h, 'run-1', 'pipeline', { pipeline_log: report });
      stat.attemptId = 'att-3';
      await visits.saveStat(stat);
      writeFileSync(runLogPath(h.root, 'run-1', 'pipeline-att-3-job-0'), hundred);
      const event = await eventOf(h, id, 'run-needs-person', { runKey: 'run-1', state: 'failed', reason: '' });

      const given = await facts.of('owner', event, 'turn-1');

      const entries = (given.ci ?? '').split('\n\n');
      expect(entries[0].split('\n').slice(0, 2)).toEqual([
        'acme/web: unit',
        `40 earlier lines are left out; the whole text is in ${WHOLE}/run-1-ci-1.txt.`,
      ]);
      expect(entries[0].endsWith('line 100')).toBe(true);
      expect(given.ci).toContain('acme/web: lint\nproject: acme/web\npipeline: 7\njob: lint');
      expect(given.ci).toContain('lint broke');
      expect(readFileSync(join(attachmentsDir(h.config, 'turn-1'), 'run-1-ci-1.txt'), 'utf8')).toBe(hundred);
    }));

  it('names the part that holds an epic, with the part facts, and a command refused or a question of a run gets its facts too', () =>
    withFacts(async (h, facts) => {
      const id = await h.addBacklog();
      await visited(h, 'epic-1', 'implement');
      await visited(h, 'part-1', 'review', { error: 'part broke' });
      const held = await eventOf(h, id, 'run-needs-person', {
        runKey: 'epic-1',
        state: 'blocked',
        reason: '',
        endRun: 'part-1',
      });
      const refused = await eventOf(h, id, 'command-refused', {
        run: 'part-1',
        refusedCommand: 'resume',
        reason: 'no',
      });
      const asked = await eventOf(h, id, 'run-asks-planner', { runKey: 'epic-1', questionId: 'q' });

      expect(await facts.of('owner', held, 'turn-1')).toMatchObject({
        part: 'part-1',
        step: 'review',
        error: 'part broke',
      });
      expect(await facts.of('owner', refused, 'turn-1')).toMatchObject({ step: 'review', error: 'part broke' });
      expect(await facts.of('owner', asked, 'turn-1')).toMatchObject({ step: 'implement' });
    }));
});
