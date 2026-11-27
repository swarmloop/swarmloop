import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { checksStillRed, implementFollowUp, implementImproveFollowUp } from '../implement/implement.prompts';
import { NEAR_TESTS_MARK, NEAR_TESTS_RULE } from './near-tests-rule';
import { PLANNER_CORE_MARK, plannerCore } from './planner-core';
import { READING_WITH_A_READER_MARK, readingWithAReader } from './reader-asking';
import { readerPrompt, skillPrompt, skillSection, skillText } from './skill-prompt';

const skill = (name: string): string => readFileSync(join(__dirname, '../../../../skills', name, 'SKILL.md'), 'utf8');

describe('impact skill rules', () => {
  it('research holds the impact section, the question form and the naming rule', () => {
    const text = skill('research');
    expect(text).toContain('`impact` has one entry per capability');
    expect(text).toContain('This change makes <capability> <unreachable|go away|change>. Is that intended?');
    expect(text).toContain('`Removes` or `Behavior change` section');
    expect(text).toContain('answered `yes`');
    expect(text).toContain('removed (named)');
    expect(text).toContain('Dead code that nothing relies on');
    expect(text).not.toContain('summary:\n- why');
  });

  it('plan skills hold the keep: item format and the stop-with-question rule', () => {
    const keep = 'keep: <capability> - files: <paths> - proof: <test>';
    expect(skill('plan')).toContain(keep);
    expect(skill('plan')).toContain('Stop and send `questions` in place of the plan');
    expect(skill('plan-improve')).toContain(keep);
    expect(skill('plan-improve')).toContain('unnamed removal: <capability>');
    expect(skill('plan')).toContain('`files:` (the paths it changes) and `proof:`');
  });

  it('plan skills say files lists every changed file and a task changing a listed file depends on it', () => {
    for (const name of ['plan', 'plan-improve']) {
      const text = skill(name);
      expect(text).toContain(
        '`files` lists every file the task will change, including its tests and the shared test helpers and fixtures they need',
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
    expect(text).toContain('One return names every id that is not met, not only the first');
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
    expect(text).toContain('Check each requirement by its id against the diff: the list, not the plan');
    expect(text).toContain('`status` (`met`, `partial` or `missing`)');
    expect(text).toContain('One return names every id that is not met, not only the first');
    expect(text).toContain('`coverage gap:`');
    expect(text).toContain("check each plan item's `proof:` against the diff");
    expect(text).toContain('Do not ask for a new subsystem the input does not ask for.');
    expect(text).toContain('Do not return that behavior again');
    expect(text.indexOf('Check each requirement by its id')).toBeLessThan(text.indexOf("plan item's `proof:`"));
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

  it('the report skill asks for the line first, then Done, Worth a look, the notes and the risk', () => {
    const text = skill('code-review/report');
    const order = ['### The line', '### Done', '### Worth a look', '### Notes', '### Risk'].map((title) =>
      text.indexOf(title),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order[0]).toBeGreaterThan(-1);
  });
});

describe('plan-improve and implement answer to the input', () => {
  it('plan-improve checks the coverage of the input before anything else', () => {
    const text = skill('plan-improve');
    expect(text).toContain('Before anything else, check the `Requirements list` in the prompt against the input');
    expect(text).toContain('`added: <item> - <why>`');
    expect(text.indexOf('Before anything else')).toBeLessThan(text.indexOf('The plan is already in the prompt'));
  });

  it.each(['implement', 'implement-improve'])('%s ends the account with a not built line', (name) => {
    const text = skill(name);
    expect(text).toContain('`not built: <item> - <why>`');
    expect(text).toContain('`not built: nothing`');
    expect(text).toContain('Stopping part way without that line is never allowed.');
  });

  it.each(['plan', 'implement'])('%s holds the limit rule', (name) => {
    const text = skill(name);
    expect(text).toContain('A limit never decides which requirement goes.');
    expect(text).toContain('do not cut another rule or requirement to make room');
    expect(text).toContain('a question to whoever started the run, before implement');
    expect(text).toContain('restructuring is the normal answer');
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
  it.each(['plan', 'plan-improve'])('%s says keep entries, tasks that change the tree and new proofs', (name) => {
    const text = skillPrompt(name, '{}', ['api'], [], [], { split: true });
    expect(text).toContain('`keep` entry');
    expect(text).toMatch(/tasks are only work that changes the tree/i);
    expect(text).toContain('`new <test>`');
  });
});

describe('implement skill rules', () => {
  const rules = [
    NEAR_TESTS_RULE,
    "Change files with the runtime's own edit and write tools, and read them with its read tool.",
    'Use the shell to run commands, not to rewrite files.',
    'Rerun each failed command in the sandbox after the change, and end only when it passes.',
    '`summary` says which command still fails and why.',
  ];

  it.each([
    ['implement skill', skillPrompt('implement', '{}', ['api'], [], [], { deferExecutionRules: true })],
    ['implement-improve skill', skillPrompt('implement-improve', '{}', ['api'], [], [], { deferExecutionRules: true })],
    ['implement follow-up', implementFollowUp('- item', null, [], null)],
    ['implement-improve follow-up', implementImproveFollowUp(null, null)],
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
    expect(text).not.toContain('run every check of `.swarmloop.json`');
    expect(text).not.toContain('Run the tests closest to the change');
  });

  it('puts the near-tests rule once in the first turn and in each follow-up', () => {
    const texts = [
      skillPrompt('implement', '{}', ['api'], [], [], { deferExecutionRules: true }),
      skillPrompt('implement-improve', '{}', ['api'], [], [], { deferExecutionRules: true }),
      implementFollowUp('- item', '## checks\nFAIL npm test', [], null),
      implementImproveFollowUp(null, null),
    ];
    for (const text of texts) {
      expect(text.split(NEAR_TESTS_RULE)).toHaveLength(2);
    }
  });

  it('has no prompt or skill that says to run every check of the project', () => {
    const skillsDir = join(__dirname, '../../../../skills');
    const files = (readdirSync(skillsDir, { recursive: true }) as string[]).filter((f) => f.endsWith('SKILL.md'));
    const texts = [
      ...files.map((file) => readFileSync(join(skillsDir, file), 'utf8')),
      skillPrompt('implement', '{}', ['api']),
      skillPrompt('implement-improve', '{}', ['api']),
      implementFollowUp('- item', '## checks\nFAIL npm test', [], null),
      implementImproveFollowUp(null, null),
      checksStillRed([{ repo: 'api', command: 'npm test', tail: 'FAIL' }], null),
    ];
    expect(files.length).toBeGreaterThan(5);
    for (const text of texts) {
      expect(text).not.toContain('run every check of `.swarmloop.json`');
    }
  });

  it('returns the quality review on a function made more complex than its limit', () => {
    const text = skill('code-review/quality');
    expect(text).toContain('A function this change makes more complex than 20');
    expect(text).toContain(
      "a function listed in the project's complexity baseline that the change makes more complex than its listed number",
    );
    expect(text).toContain('the fix is a split by responsibility');
  });

  it('implement moves out the part of a listed function it touches first', () => {
    const text = skill('implement');
    expect(text).toContain(
      "add to a function listed in the project's complexity baseline, it first moves out the part it touches",
    );
    expect(text).toContain('It never adds an entry to the list');
  });

  it('the security skill follows every outside value to its use', () => {
    const text = skill('code-review/security');
    const phrases = [
      'HTTP path, query, body, headers and cookies',
      'uploaded files and their names',
      'CLI arguments',
      'webhook payloads',
      'values from a code host',
      "an agent's output",
      'env read at request time',
      'a file path (resolved, then required to stay inside its root)',
      'a process argument (an argument array with no shell, never a shell string)',
      'a URL the server fetches (an allowed host)',
      'HTML or markdown shown to a person (escaped)',
      'a raw SQL string or a regular expression built from it',
      'an object key (no `__proto__`, `constructor`)',
      'a redirect target',
      'a log line (no secret)',
      'is checked to be a string, because a query or body field may be an array',
      'the same authorization as their neighbours',
      'a finding of one of them in the diff is critical, not hypothetical',
      'lists every outside value and where it goes',
    ];
    for (const phrase of phrases) expect(text).toContain(phrase);
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

  it('swaps the near-tests mark for the rule', () => {
    expect(skillText(['a', NEAR_TESTS_MARK, 'b'].join('\n'), true)).toBe(['a', NEAR_TESTS_RULE, 'b'].join('\n'));
  });

  it('swaps the planner core mark for the core text', () => {
    expect(skillText(['a', PLANNER_CORE_MARK, 'b'].join('\n'), true)).toBe(['a', plannerCore(), 'b'].join('\n'));
  });

  it('swaps the reading-with-a-reader mark for the asking text', () => {
    expect(skillText(['a', READING_WITH_A_READER_MARK, 'b'].join('\n'), true)).toBe(
      ['a', readingWithAReader(), 'b'].join('\n'),
    );
  });

  it('reads a part of the core by its heading through skillSection', () => {
    const part = skillSection('plan', 'Pass up what you do not hold');
    expect(part).not.toBe('');
    expect(plannerCore()).toContain(part);
  });

  it('gives the core to a reader of the backlog skill and to no reader of the implement skill', () => {
    expect(skillPrompt('backlog-plan', '{}', ['api'])).toContain(plannerCore());
    expect(skillPrompt('implement', '{}', ['api'])).not.toContain(plannerCore());
  });

  it('leaves the quote check out of the core and gives the asking text to the skill of a role with a reader only', () => {
    expect(plannerCore()).not.toContain('A fact checked by its quote');
    expect(skillPrompt('backlog-plan', '{}', ['api'])).toContain(readingWithAReader());
    expect(skillPrompt('plan', '{}', ['api'])).not.toContain(readingWithAReader());
    expect(skillPrompt('implement', '{}', ['api'])).not.toContain(readingWithAReader());
  });

  it('leaves a text without markers as it is', () => {
    expect(skillText('a\n\nb\n', false)).toBe('a\n\nb\n');
  });
});

describe('the plan skills', () => {
  it.each(['plan', 'plan-improve'])('the %s prompt is the same for every runtime and names no answer label', (name) => {
    const prompt = skillPrompt(name, '{}', ['api'], [], [], { split: true });
    expect(skillPrompt(name, '{}', ['api'], [], [], { split: true, planTool: false })).toBe(prompt);
    expect(prompt).not.toMatch(/\[(no )?plan tool\]/);
    expect(prompt).not.toMatch(/^(plan|summary|tasks|contract|keep|questions):$/m);
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

    expect(plan).toContain('sends `needs`');
    expect(plan).toContain('A checklist never has an item like "stop and report if X is missing"');
    expect(plan).not.toMatch(/^- .*stop and report/im);
  });

  it('plan says when and how to send needs', () => {
    expect(skill('plan')).toContain('sends `needs`, one entry per sibling task id with what it needs from that task');
  });

  it('implement says when to send needs, and leaves the format to the result schema', () => {
    expect(skill('implement')).toContain('fill `needs` with one entry per sibling task');
    expect(skill('implement')).not.toContain('`- <id>: <what it needs from that task>`');
  });

  it('research says when to send needs, and leaves the format to the result schema', () => {
    const text = skill('research');
    expect(text).toContain('Then send `needs` and nothing else');
    expect(text).not.toContain('`- <id>: <what it needs from that task>`');
  });

  it('limits a fix that makes a job pass to the files of the task and leaves a red job of a sibling alone', () => {
    const text = skill('implement');

    expect(text).toContain("part of the task only within the task's own files");
    expect(text).toContain('named as the cause in `cause` and left alone');
  });

  it.each(['code-review/requirements', 'code-review/regressions'])(
    '%s returns a change to the file of another task with no dependency path',
    (name) => {
      expect(skill(name)).toMatch(/a change to a file .* another task lists/);
    },
  );
});

describe('the project base pointer', () => {
  const base = '/work/brief/skills/implement/project-base.md';

  it.each(['plan', 'implement', 'code-review/requirements'])(
    '%s names the project base file and holds none of its list',
    (name) => {
      const text = skill(name);
      expect(text).toContain(base);
      for (const point of ['400 counted lines', 'CHANGELOG.md', 'Unreleased', 'at most 12']) {
        expect(text).not.toContain(point);
      }
    },
  );

  it('requirements reads every base point against the diff and returns missing points by name', () => {
    const text = skill('code-review/requirements');
    expect(text).toContain(`For a base task, read ${base}`);
    expect(text).toContain('check every point against the diff');
    expect(text).toContain('naming each missing point in a return');
  });

  it('plan names the project base file for a run that does not split', () => {
    expect(skillPrompt('plan', '{}', ['api'])).toContain(base);
  });
});

describe('the reader', () => {
  const named = /claude|codex|cursor|sonnet|opus|haiku|gpt/i;
  const tools = /\b(Task|Agent|Grep|Glob|Bash|Explore)\b/;

  it('is told to quote, read whole blocks, search and count lists, say not found, mark inferences and not advise', () => {
    const prompt = readerPrompt();
    expect(prompt).toContain('Answer only what was asked');
    expect(prompt).toContain('quote the exact line');
    expect(prompt).toContain('Read the whole function or block before you say what it does');
    expect(prompt).toContain('Quote its guards and its branches instead of summing them up');
    expect(prompt).toContain('search the whole tree. Give the search you used and the count');
    expect(prompt).toContain('never cut the list silently');
    expect(prompt).toContain('`not found` with the search that found nothing');
    expect(prompt).toContain('as an inference');
    expect(prompt).toContain('contradicts');
    expect(prompt).toContain('Give no advice, no plan and no opinion');
    expect(prompt).toContain('You never change a file');
  });

  it('names no runtime, model or tool', () => {
    expect(readerPrompt()).not.toMatch(named);
    expect(readerPrompt()).not.toMatch(tools);
    expect(readingWithAReader()).not.toMatch(named);
    expect(readingWithAReader()).not.toMatch(tools);
  });

  it('is asked narrowly, with the agent reading itself only to settle a doubt', () => {
    const asking = readingWithAReader();
    expect(asking).toContain('Ask narrow questions that name the files, the symbols and what you need');
    expect(asking).toContain('Ask everything that is independent in one call');
    expect(asking).toContain('ask for the full list with the search that made it');
    expect(asking).toContain('ask again more narrowly. Never fill the gap yourself');
    expect(asking).toContain('with one search for the quoted line, and never by rereading the file');
    expect(asking).toContain(
      "Hand the reading to the reader. Read yourself only to settle a doubt: a quote is missing, vague or marked as an inference, two facts disagree, or a decision rests on the fact and the reader's second, narrower answer did not settle it. Then read only the lines that settle it, the quoted range and the function around it, never a file or a search sweep the reader could do.",
    );
    expect(asking).toContain('The decisions, the actions and the result block are yours');
  });
});
