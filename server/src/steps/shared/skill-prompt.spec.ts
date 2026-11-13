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

  it('plan skills say files lists every changed file and a task changing a listed file depends on it', () => {
    for (const name of ['plan', 'plan-improve']) {
      const text = skill(name);
      expect(text).toContain(
        '`files:` lists every file the task will change, including its tests and the shared test helpers and fixtures they need',
      );
      expect(text).toContain('a task that changes a file another task lists depends on that task');
    }
  });

  it('requirements holds the removal rule and the dead-code exception, and not the old sentence', () => {
    const text = skill('code-review/requirements');
    expect(text).toContain('A behavior the diff removes or makes unreachable is a return unless the task names it');
    expect(text).toContain('The approved checklist alone does not authorize a removal.');
    expect(text).toContain('Dead code that nothing relies on');
    expect(text).not.toContain('A behavior that checklist removes is not a missing requirement');
    expect(text).toContain('the return names every one of them, not only the first');
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

describe('review against the input', () => {
  const reviewers = [
    'code-review',
    'code-review/requirements',
    'code-review/quality',
    'code-review/regressions',
    'code-review/security',
    'code-review/performance',
  ];
  const authority =
    "the input says what must be true, the plan says how, implement's account says why it was done this way";
  const loosened =
    'loosens or removes an assertion, skips or deletes a test, or widens a tolerance. That is a return unless';

  it('requirements lists the input, checks each item and returns every unmet one at once', () => {
    const text = skill('code-review/requirements');
    expect(text).toContain("list what the input asks for, numbered in the input's order");
    expect(text).toContain('Then check each one against the code.');
    expect(text).toContain('`met: <item> (<where>)`, `partial: <item> - <what is missing>` or `missing: <item>`');
    expect(text).toContain('the return names every one of them, not only the first');
    expect(text).toContain("check each plan item's `proof:` against the diff");
    expect(text).toContain('Do not ask for a new subsystem the input does not ask for.');
    expect(text).toContain('Do not return that behavior again');
    expect(text.indexOf('list what the input asks for')).toBeLessThan(text.indexOf("plan item's `proof:`"));
  });

  it.each(reviewers)('%s holds the authority line and never passes on the plan alone', (name) => {
    const text = skill(name);
    expect(text).toContain(authority);
    expect(text).toContain('"The plan said to stop" and "the plan asks nothing more" are never a reason');
    expect(text).toContain('is never the reason on its own');
    expect(text).not.toContain('already what the approved plan asks');
  });

  it.each(['code-review/requirements', 'code-review/regressions'])(
    '%s returns a loosened assertion in a CI fix',
    (name) => {
      const text = skill(name);
      expect(text).toContain(loosened);
      expect(text).toContain(
        "implement's account says why the old assertion was wrong and what the new one still proves",
      );
      expect(text).toContain('Do not take it on trust.');
    },
  );

  it('the report opens with the requirements list', () => {
    const text = skill('code-review/report');
    expect(text.indexOf('## Requirements')).toBeGreaterThan(-1);
    expect(text.indexOf('## Requirements')).toBeLessThan(text.indexOf('## What changed'));
  });
});

describe('plan-improve and implement answer to the input', () => {
  it('plan-improve checks the coverage of the input before anything else', () => {
    const text = skill('plan-improve');
    expect(text).toContain('Before anything else, list every item the input asks for');
    expect(text).toContain('`- added: <item> - <why>`');
    expect(text.indexOf('Before anything else')).toBeLessThan(text.indexOf('[plan tool]'));
  });

  it.each(['implement', 'implement-improve'])('%s ends the account with a not built line', (name) => {
    const text = skill(name);
    expect(text).toContain('`not built: <item> - <why>`');
    expect(text).toContain('`not built: nothing`');
    expect(text).toContain('Stopping part way without that line is never allowed.');
  });

  it('implement changes a test only when the test is wrong and says why', () => {
    expect(skill('implement')).toContain(
      'Change a test only when the test is wrong, and say in `summary` why the old assertion was wrong',
    );
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

describe('the split keep: section', () => {
  it.each(['plan', 'plan-improve'])('%s says keep: lines, tasks that change the tree and proof: new', (name) => {
    const text = skillPrompt(name, '{}', ['api'], [], [], { split: true });
    expect(text).toContain('- <capability> | proof: <test or new <test>> | tasks: <ids');
    expect(text).toMatch(/tasks are only work that changes the tree/i);
    expect(text).toContain('proof: new <test>');
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

describe('project rules in a skill prompt', () => {
  const rules = [{ heading: 'Project rules (api)', body: 'Keep it small.\n' }];

  it('is byte-identical without rules', () => {
    expect(skillPrompt('plan', '{}', ['api'], [], [], { rules: [] })).toBe(skillPrompt('plan', '{}', ['api']));
  });

  it('puts each section after the skill text and before the requirements', () => {
    const prompt = skillPrompt('plan', '{}', ['api'], [], [], { rules });
    const skillEnd = prompt.indexOf('Project rules (api):');
    expect(skillEnd).toBeGreaterThan(prompt.indexOf('# '));
    expect(prompt).toContain('Project rules (api):\nKeep it small.\n\nRequirements:');
  });
});

describe('fix-the-cause sentence', () => {
  it.each(['implement', 'implement-improve', 'code-review/quality', 'code-review/regressions'])(
    '%s names the special case keyed on what the failure showed',
    (name) => {
      expect(skill(name)).toContain('keyed on the specific name, message text, id or value seen in the failure');
    },
  );

  it.each(['code-review/quality', 'code-review/regressions'])(
    "%s reads implement's cause against the failure and the diff",
    (name) => {
      expect(skill(name)).toContain("Read implement's `cause:` against the failure and the diff");
    },
  );
});

describe('needs: a task that needs a sibling waits for it', () => {
  it('has the plan skill name needs: and never ask for a stop-and-report item', () => {
    const plan = skill('plan');

    expect(plan).toContain('`needs:`');
    expect(plan).toContain('A checklist never has an item like "stop and report if X is missing"');
    expect(plan).not.toMatch(/^- .*stop and report/im);
  });

  it.each(['research', 'plan', 'implement'])('%s says when and how to write needs:', (name) => {
    expect(skill(name)).toContain('`- <id>: <what it needs from that task>`');
  });

  it('limits a fix that makes a job pass to the files of the task and leaves a red job of a sibling alone', () => {
    const text = skill('implement');

    expect(text).toContain("part of the task only within the task's own files");
    expect(text).toContain('named as the cause in `cause:` and left alone');
  });

  it.each(['code-review/requirements', 'code-review/regressions'])(
    '%s returns a change to the file of another task with no dependency path',
    (name) => {
      expect(skill(name)).toMatch(/a change to a file .* another task lists/);
    },
  );
});
