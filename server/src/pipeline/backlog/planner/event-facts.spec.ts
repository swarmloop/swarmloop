import type { BacklogEventKind } from '../../../contract/backlog';
import { ARTIFACTS } from '../../../steps/contract/artifacts';
import { EventFacts } from './event-facts';
import { plannerFacts } from './planner-facts.spec-helpers';

type Harness = Awaited<ReturnType<typeof plannerFacts>>;

async function withFacts(body: (h: Harness, facts: EventFacts) => Promise<void>): Promise<void> {
  const h = await plannerFacts();
  try {
    await body(h, new EventFacts(h.backlogs, h.documents, h.host));
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

      expect(await facts.of('owner', event)).toMatchObject({
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

      expect(await facts.of('owner', event)).toMatchObject({
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

      expect((await facts.of('owner', asked)).question).toBe('Which library?');
      expect((await facts.of('owner', none)).note).toBe('the run has no stored question');
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

      expect(await facts.of('owner', event)).toMatchObject({
        slug: 'a',
        report: 'Ready to merge',
        requirements: 'R1 is met: in x.ts',
        diff: '- added x.ts',
      });
    }));

  it('says why a merged task has no facts to read', () =>
    withFacts(async (h, facts) => {
      const id = await h.addBacklog();
      await h.addTask(id, 'a');
      const event = await eventOf(h, id, 'task-merged', { slug: 'a' });

      expect((await facts.of('owner', event)).note).toBe('the task has no run');
    }));

  it('gives a red main its failing job and the tail of its log, and says how much is left out and where the whole is', () =>
    withFacts(async (h, facts) => {
      const id = await h.addBacklog();
      h.redMain('web', Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join('\n'));
      const event = await eventOf(h, id, 'main-red', { repository: 'web', head: 'h1' });

      const given = await facts.of('owner', event);

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

      expect((await facts.of('owner', event)).log).toBe('boom');
    }));

  it('turns a read that fails into a note instead of failing the turn', () =>
    withFacts(async (h, facts) => {
      const id = await h.addBacklog();
      const event = await eventOf(h, id, 'main-red', { repository: 'unknown', head: 'h1' });

      expect((await facts.of('owner', event)).note).toMatch(/^its facts could not be read: /);
    }));

  it('passes the person message and the planner reply of a run chat through', () =>
    withFacts(async (h, facts) => {
      const id = await h.addBacklog();
      const event = await eventOf(h, id, 'run-chat', { slug: 'a', message: 'use x', reply: 'done' });

      expect(await facts.of('owner', event)).toEqual({ slug: 'a', message: 'use x', reply: 'done' });
    }));
});
