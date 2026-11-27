import { backlogTurn } from './definitions/backlog-turn';
import { readResult } from './read-result';
import { resultFollowUp } from './result-follow-up';
import { RESULT_AS_BEFORE, resultPrompt, resultPromptFor } from './result-prompt';
import { sample } from './result.spec-helpers';

describe('resultPrompt', () => {
  it('lists every field with its type, whether it is required, and its description', () => {
    const text = resultPrompt(sample);
    expect(text).toContain('- title (string, required): A short title');
    expect(text).toContain('- items (array of string, required): One entry per line');
    expect(text).toContain('- decision (one of "ok", "return", required): The verdict');
    expect(text).toContain('- note (string, optional): Anything else');
    expect(text).toContain('- tasks[].id (string, required): The task id');
  });
});

describe('resultPromptFor', () => {
  it('gives the full text for a new chat and for a different definition', () => {
    expect(resultPromptFor(sample, null)).toBe(resultPrompt(sample));
    expect(resultPromptFor(sample, 'other')).toBe(resultPrompt(sample));
  });

  it('gives one line for a definition the chat already received', () => {
    expect(resultPromptFor(sample, 'sample')).toBe(RESULT_AS_BEFORE);
  });
});

describe('resultFollowUp', () => {
  it('holds every error and the one line, and no schema', () => {
    const text = resultFollowUp(['a: bad', 'b: worse'], sample);
    expect(text).toContain('- a: bad');
    expect(text).toContain('- b: worse');
    expect(text).toContain('Answer with the result block only');
    expect(text).not.toContain('(string');
  });

  it('shows the field of a wrong value under its error', () => {
    const text = resultFollowUp(['decision: "decision" must be one of [ok, return]'], sample);
    expect(text).toContain('  - decision (one of "ok", "return", required)');
  });

  it('shows the field list for a block that cannot be read', () => {
    const text = resultFollowUp(['the answer has no result block: end it'], sample);
    expect(text).toContain('- title (string, required)');
    expect(text).toContain('- tasks[].id (string, required)');
  });

  it('keeps the line of a check of the server alone', () => {
    const text = resultFollowUp(['R1 is not covered: x'], sample);
    expect(text).toContain('- R1 is not covered: x');
    expect(text).not.toContain('(string');
    expect(resultFollowUp(['decision: bad'], undefined)).not.toContain('(one of');
  });

  it('shows a part once for several errors about it', () => {
    const text = resultFollowUp(['tasks.0.id: "id" is required', 'tasks.1.id: "id" is required'], sample);
    expect(text.split('- tasks[].id (string, required)')).toHaveLength(2);
  });

  describe('for the backlog turn', () => {
    const follow = (action: unknown): string => {
      const read = readResult(backlogTurn, `\`\`\`json\n${JSON.stringify({ actions: [action] })}\n\`\`\``);
      return resultFollowUp(read.ok ? [] : read.errors, backlogTurn);
    };

    it('lists the allowed action names for an unknown action', () => {
      const text = follow({ action: 'addBacklogItem' });
      expect(text).toContain('- actions[].action (one of "proposeMilestone"');
      expect(text).toContain('"addItem"');
    });

    it('names the fields an action needs, with their types', () => {
      const text = follow({ action: 'addItem', title: 't' });
      expect(text).toMatch(/- addItem needs: id \(string\), title \(string\), description \(string\)/);
    });

    it('groups the refusal of one key in many actions into one line with every place', () => {
      const actions = [0, 1, 2].map(() => ({ action: 'pause', slug: 'x' }));
      const read = readResult(backlogTurn, `\`\`\`json\n${JSON.stringify({ actions })}\n\`\`\``);
      const text = resultFollowUp(read.ok ? [] : read.errors, backlogTurn);
      expect(text).toContain(
        '- actions[].slug: "actions[].slug" is not allowed (3 places: actions.0.slug, actions.1.slug, actions.2.slug)',
      );
      expect(text).not.toContain('- actions.0.slug');
      expect(text.split('- actions[] takes only these keys: action, reason,')).toHaveLength(2);
      expect(text).toContain('  - addItem needs: id (string), title (string), description (string)');
    });

    it('lists the keys of the result for an unknown key at the root', () => {
      const read = readResult(backlogTurn, '```json\n{"kind":"x"}\n```');
      const text = resultFollowUp(read.ok ? [] : read.errors, backlogTurn);
      expect(text).toContain('- the result takes only these keys: say, actions');
    });

    it('keeps every place and every line whole for many errors with long keys', () => {
      const key = 'a'.repeat(120);
      const errors = Array.from(
        { length: 200 },
        (_, index) => `actions.${index}.${key}: "actions[${index}].${key}" is not allowed`,
      );
      const text = resultFollowUp(errors, backlogTurn);
      errors.forEach((error) => expect(text).toContain(error.slice(0, error.indexOf(': '))));
      expect(text).toContain(`- actions[].${key}: "actions[].${key}" is not allowed (200 places: `);
      expect(text.split('\n').every((line) => line === '' || /^( {2})?- |^The result|^Answer/.test(line))).toBe(true);
    });

    it('shows the action field once for an action given as an object', () => {
      const text = follow({ action: { kind: 'addItem' } });
      expect(text.split('- actions[].action (one of').length).toBe(2);
    });
  });
});
