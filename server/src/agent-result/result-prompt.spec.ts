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
    expect(text).toContain(RESULT_AS_BEFORE);
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

    it('shows the action field once for an action given as an object', () => {
      const text = follow({ action: { kind: 'addItem' } });
      expect(text.split('- actions[].action (one of').length).toBe(2);
    });
  });
});
