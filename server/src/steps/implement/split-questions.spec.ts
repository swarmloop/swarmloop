import type { RunEntity } from '../../history/entities';
import type { Subtask } from '../../contract/subtask';
import { renderQuestions } from '../research/research-record';
import type { Delivery, SubtaskOps } from '../shared/subtask-ops';
import { questionFor, SplitQuestions } from './split-questions';

const AT = '2026-01-01T00:00:00.000Z';
const parent = { key: 'epic' } as RunEntity;
const tasks = [{ id: 'a', status: 'running' }] as Subtask[];
const question = questionFor('a', 'Which column?', AT);
const body = renderQuestions([question]);
const answers = `question: ${question}\nanswer: The id column.\n`;

/** One part `a`, as far as the epic's delivery reads it. */
function world(options: { asking: boolean; held: boolean[]; delivered: Delivery; needs?: string[] }) {
  const held = [...options.held];
  const sent: string[] = [];
  const subtasks = {
    find: async (_run: RunEntity, id: string) => ({ key: `epic-${id}` }),
    held: async () => held[0] ?? false,
    sendHeld: async () => {
      sent.push('held start');
      return held.shift() ? 'held' : 'sent';
    },
    asking: async () => options.asking,
    needsOf: async () => (options.needs ?? []).map((id) => ({ id, what: 'w', why: '' })),
    rerun: async (_child: RunEntity, lines: string[]) => {
      sent.push(`rerun: ${lines.join('|')}`);
      return options.delivered;
    },
    deliverAnswer: async (_child: RunEntity, text: string) => {
      sent.push(`answer: ${text}`);
      return options.delivered;
    },
  };
  return { questions: new SplitQuestions(subtasks as unknown as SubtaskOps), sent };
}

describe('SplitQuestions deliver', () => {
  it('closes the line and writes the decision when the part is held, without failing', async () => {
    const { questions, sent } = world({ asking: true, held: [], delivered: 'held' });

    const result = await questions.deliver(parent, '', body, answers, AT, tasks);

    expect(sent).toEqual(['answer: The id column.']);
    expect(result.body).toBe('');
    expect(result.contract).toContain('The id column.');
  });

  it('sends a held start again before it delivers an answer, at every pass', async () => {
    const { questions, sent } = world({ asking: true, held: [true], delivered: 'sent' });

    await questions.deliver(parent, '', body, answers, AT, tasks);

    expect(sent).toEqual(['held start', 'answer: The id column.']);
  });

  it('sends nothing for a part that holds no start and has no answer', async () => {
    const { questions, sent } = world({ asking: false, held: [], delivered: 'sent' });

    const result = await questions.deliver(parent, '', body, '', AT, tasks);

    expect(sent).toEqual([]);
    expect(result.body).toBe(body);
  });
});

describe('SplitQuestions handDown', () => {
  it('gives a part that asks the answer and writes the decision at the given time', async () => {
    const { questions, sent } = world({ asking: true, held: [], delivered: 'sent' });

    const contract = await questions.handDown(parent, 'a', 'The id column.', AT, '');

    expect(sent).toEqual(['answer: The id column.']);
    expect(contract).toContain('The id column.');
  });

  it('reruns a part that waits with needs with the answer as its line, and a held part keeps the decision', async () => {
    const { questions, sent } = world({ asking: false, held: [], delivered: 'held', needs: ['b'] });

    const contract = await questions.handDown(parent, 'a', 'Use b.', AT, '');

    expect(sent).toEqual(['rerun: Use b.']);
    expect(contract).toContain('Use b.');
  });
});
