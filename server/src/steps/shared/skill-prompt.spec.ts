import { readFileSync } from 'fs';
import { join } from 'path';
import { implementFollowUp, implementImproveFollowUp } from '../implement/implement.prompts';
import { parseSummary, skillPrompt, skillText, summaryOr } from './skill-prompt';

const skill = (name: string): string => readFileSync(join(__dirname, '../../../../skills', name, 'SKILL.md'), 'utf8');

const old = ['implementation:', '- changed A', '', 'summary:', '- why', ''].join('\n');
const withCause = ['cause:', '- the parser dropped the suffix', '', old].join('\n');
const causeAfter = `${old}\ncause:\n- late cause\n`;

describe('parseSummary', () => {
  it('reads the summary of an old answer', () => {
    expect(parseSummary(old)).toBe('- why\n');
  });

  it('keeps a cause section out of the summary', () => {
    expect(parseSummary(withCause)).toBe('- why\n');
    expect(parseSummary(causeAfter)).toBe('- why\n');
  });
});

describe('summaryOr', () => {
  it('reads the summary and falls back when it is missing', () => {
    expect(summaryOr(withCause, 'fallback')).toBe('- why\n');
    expect(summaryOr('cause:\n- only a cause\n', 'fallback')).toBe('fallback\n');
  });
});

describe('impact skill rules', () => {
  it('research holds the impact section, the question form and the naming rule', () => {
    const text = skill('research');
    expect(text).toContain('- <capability> | <file> | kept | changed | removed | unreachable');
    expect(text).toContain('This change makes <capability> <unreachable|go away|change>. Is that intended?');
    expect(text).toContain('`Removes` or `Behavior change` section');
    expect(text).toContain('answered `yes`');
    expect(text).toContain('removed (named)');
    expect(text).toContain('Dead code that nothing relies on');
    expect(text.indexOf('impact:\n- capability')).toBeLessThan(text.indexOf('summary:\n- why'));
  });

  it('plan skills hold the keep: item format and the stop-with-question rule', () => {
    const keep = '- keep: <capability> - files: <paths> - proof: <test>';
    expect(skill('plan')).toContain(keep);
    expect(skill('plan')).toContain('Stop and end with a `questions:` section');
    expect(skill('plan-improve')).toContain(keep);
    expect(skill('plan-improve')).toContain('- unnamed removal: <capability>');
    expect(skill('plan')).toContain('`files:` (the paths it changes) and `proof:`');
  });

  it('requirements holds the removal rule and the dead-code exception, and not the old sentence', () => {
    const text = skill('code-review/requirements');
    expect(text).toContain('A behavior the diff removes or makes unreachable is a return unless the task names it');
    expect(text).toContain('The approved checklist alone does not authorize a removal.');
    expect(text).toContain('Dead code that nothing relies on');
    expect(text).not.toContain('A behavior that checklist removes is not a missing requirement');
    expect(text).toContain('name one broken behavior');
    expect(text).toContain('decision: return');
  });

  it('regressions holds the reachability rule, the named-capability exception and the return lines', () => {
    const text = skill('code-review/regressions');
    expect(text).toContain('Read the Impact section');
    expect(text).toContain('still reachable with the data the system writes now');
    expect(text).toContain('always true or always false counts as removal');
    expect(text).toContain('Name the capability in the return.');
    expect(text).toContain('named in `Removes` or `Behavior change`');
    expect(text).toContain('name one broken behavior');
    expect(text).toContain('decision: return');
  });
});

describe('split skill text', () => {
  it.each(['plan', 'plan-improve'])('no split text when the run may not split (%s)', (name) => {
    const plain = skillPrompt(name, '{}', ['api']);
    expect(plain).not.toContain('## Split');
    expect(plain).not.toContain('tasks:');
    expect(skillPrompt(name, '{}', ['api'], [], [], { split: true })).toContain('## Split');
    expect(plain).toBe(skillPrompt(name, '{}', ['api'], [], [], { split: false }));
  });
});

describe('implement skill rules', () => {
  const rules = [
    'Run the tests closest to the change: the spec files of the changed code and the ones that import it.',
    "Do not run the project's full check commands.",
    "Change files with the runtime's own edit and write tools, and read them with its read tool.",
    'Use the shell to run commands, not to rewrite files.',
    'Rerun each failed command in the sandbox after the change, and end only when it passes.',
    '`summary` says which command still fails and why.',
  ];

  it.each([
    ['implement skill', skill('implement')],
    ['implement-improve skill', skill('implement-improve')],
    ['implement follow-up', implementFollowUp('- item', null)],
    ['implement-improve follow-up', implementImproveFollowUp(null)],
  ])('%s holds the near-tests, edit-tool and rerun rules', (_name, text) => {
    for (const rule of rules) {
      expect(text).toContain(rule);
    }
  });

  it.each(['implement', 'implement-improve'])('%s skill holds the structure and quick-check rules', (name) => {
    const text = skill(name);
    expect(text).toContain('A new responsibility goes in its own file, named for it.');
    expect(text).toContain('is split by responsibility, never squeezed');
    expect(text).toContain('search the tree for one that does the same and use it');
    expect(text).toContain("also run the project's quick checks that apply to the change");
  });

  it('returns the quality review on squeezed code and on duplicated logic', () => {
    const text = skill('code-review/quality');
    expect(text).toContain('code was squeezed to pass a rule');
    expect(text).toContain('new logic duplicates existing code');
  });

  it('keeps implement-improve from ending on a red command', () => {
    expect(skill('implement-improve')).toContain('When there is no gap and no command came back red, leave the files.');
  });

  it.each(['research', 'plan', 'plan-improve', 'implement', 'implement-improve', 'requirements', 'jira'])(
    '%s names no runtime tool',
    (name) => {
      expect(skill(name)).not.toMatch(/\b(Glob|Grep)\b/);
    },
  );
});

describe('skillText', () => {
  const raw = ['common', '[plan tool] with', '[no plan tool] without', 'end'].join('\n');

  it('keeps the lines of the runtime with a plan tool', () => {
    expect(skillText(raw, true)).toBe(['common', 'with', 'end'].join('\n'));
  });

  it('keeps the lines of the runtime without one', () => {
    expect(skillText(raw, false)).toBe(['common', 'without', 'end'].join('\n'));
  });

  it('leaves a text without markers as it is', () => {
    expect(skillText('a\n\nb\n', false)).toBe('a\n\nb\n');
  });
});

describe('the plan skills for a runtime without a plan tool', () => {
  const names = ['api'];

  it.each(['plan', 'plan-improve'])('the %s prompt names no plan tool', (name) => {
    expect(skillPrompt(name, '{}', names, [], [], { split: true, planTool: false })).not.toContain('plan tool');
  });

  it.each([
    ['plan', 'Write the checklist with the plan tool. That is how a later pass replaces the plan.'],
    ['plan-improve', 'Use the plan tool or a `plan` section. Either one replaces the checklist.'],
  ])('the %s prompt with a plan tool keeps its sentence and no marker', (name, sentence) => {
    const prompt = skillPrompt(name, '{}', names, [], [], { split: true });
    expect(prompt).toContain(sentence);
    expect(prompt).not.toMatch(/\[(no )?plan tool\]/);
  });
});
