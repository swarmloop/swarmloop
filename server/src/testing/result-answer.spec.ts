import Joi from 'joi';
import { readResult } from '../agent-result/read-result';
import { defineResult } from '../agent-result/result-definition';
import { BlockAgentRunner, resultAnswer } from './result-answer';

const definition = defineResult('sample', Joi.object({ items: Joi.array().items(Joi.string()).required() }));

describe('result answer', () => {
  it('ends the prose with a block the reader accepts', () => {
    const text = resultAnswer('Done.', { items: ['a'] });
    expect(text.startsWith('Done.\n\n```json\n')).toBe(true);
    expect(readResult(definition, text)).toEqual({ ok: true, value: { items: ['a'] } });
  });
});

describe('BlockAgentRunner', () => {
  it('answers a step from its script in order, then with its default, and records the steps', async () => {
    const runner = new BlockAgentRunner(
      { plan: [{ block: { items: ['first'] } }, { text: 'prose only' }] },
      { plan: { items: ['default'] } },
    );
    const texts: string[] = [];
    for (let launch = 0; launch < 3; launch += 1) {
      texts.push((await runner.run({ step: 'plan', prompt: `p${launch}` })).responseText);
    }
    expect(readResult(definition, texts[0])).toEqual({ ok: true, value: { items: ['first'] } });
    expect(texts[1]).toBe('prose only');
    expect(readResult(definition, texts[2])).toEqual({ ok: true, value: { items: ['default'] } });
    expect(runner.steps).toEqual(['plan', 'plan', 'plan']);
  });
});
