import { readFileSync } from 'fs';
import { join } from 'path';

import { plannerCore } from '../../steps/shared/planner-core';
import { skillPrompt } from '../../steps/shared/skill-prompt';

const skill = readFileSync(join(__dirname, '../../../../skills/backlog-plan/SKILL.md'), 'utf8');
const prompt = skillPrompt('backlog-plan', '{}', ['api']);
const core = plannerCore();

const CASES = [
  "a new behavior for the product's users",
  'a change of the requirements or the goal, or of an order the person set',
  'money (limits, plans)',
  'what a public repository shows about a person',
  'anything that weakens a project rule (security, a test, CI)',
  'anything you are not sure of',
];

/** Sentences the core holds once, which the backlog skill must not repeat. */
const CORE_SENTENCES = [
  'No change is the usual answer.',
  'The server computes the marks, so you do not search the code for them',
  'the files its merge request changed outside its files or its plan, its `not built:` lines, and the requirements its review left unmet',
  'Give each decision with a one-line reason that names the goal',
  'the facts you were given, each with the file and line it rests on, to be checked against main',
  'you do no code research to write a brief',
  'quotes each fact by its exact line, with its file and its line number',
  'check its quote with one search and do not reread the file',
];

const GENERAL_RULES = [
  'Behavior stays as today unless `Behavior change` says so (routes and payloads, settings and defaults, data and schema, texts people and agents see, the UI).',
  'Data changes are additive migrations; existing tests keep their names, and assertions change only where the brief says so.',
  "Run the tests, builds and linters for the change before handing over; CI on the branch runs them again and is the judge; every check, test or lint rule the brief adds goes into the project's CI in the same change.",
  'No new dependency unless the brief names it; a small diff, no drive-by edits or renames outside the scope.',
  'Never raise a timeout, a retry count or a poll limit to make a test pass: find the cause.',
  "Follow the project's own rules (`AGENTS.md`, its skills, its manifest).",
  "In the summary, each `Check` item says `enforced by job <name>` or `checked by reading <file>`, never that a command passed; an item with neither is the summary's first line as `unmet: <item> - <reason>`.",
];

const BRIEF_SECTIONS = ['Rules', 'Today', 'Do', 'Must keep', 'Behavior change', 'Pipeline', 'Check'];

describe('the backlog-plan skill', () => {
  it.each(GENERAL_RULES)('holds the general rule: %s', (rule) => {
    expect(skill).toContain(`- ${rule}`);
  });

  it.each(BRIEF_SECTIONS)('names the brief section %s', (section) => {
    expect(skill).toContain(`\`${section}\``);
  });

  it('reads the shared rules from the core, once, and repeats none of them', () => {
    expect(prompt).toContain(core);
    expect(skill.split('[planner core]')).toHaveLength(2);
    for (const rule of CORE_SENTENCES) {
      expect(core).toContain(rule);
      expect(skill).not.toContain(rule);
    }
  });

  it('reads the marks of every merge, whether or not the task covers a requirement, and adds a fix task for a real miss', () => {
    const section = skill.slice(skill.indexOf('## After a merge'), skill.indexOf('## Before anything starts'));
    expect(section).toContain(
      'Whether or not the task covers a milestone requirement, read its marks against its brief, as `The look after a merge` says',
    );
    expect(section).toContain("the report and the review's per-id statuses");
    expect(section).toContain('A real miss gets a fix task in the same milestone, with a one-line reason in the chat');
    expect(section).toContain('Close it with its evidence from the per-id statuses');
    expect(section).toContain('every task of the backlog that has not started');
  });

  it('writes a brief whose Today carries what the planner was given and leaves code research to the task', () => {
    expect(skill).toContain('`Today`: what `A new task or a plan change` says a brief carries.');
    expect(skill).not.toContain('with names and evidence');
  });

  it('hands heavy reading to a helper, rereads the lines a fact rests on, and names no runtime, model or tool', () => {
    const start = skill.indexOf('## Reading with a helper');
    const section = skill.slice(start, skill.indexOf('\n## ', start + 1));
    expect(section).toContain('Hand it the heavy reading: code, long briefs, logs and diffs');
    expect(section).toContain('Ask it for the facts you need');
    expect(section).not.toContain('read yourself the lines it rests on');
    expect(section).toContain('you read code only through it, and the launch holds you to it');
    expect(section).toContain('each quoted as `A fact checked by its quote` says');
    expect(section).toContain("long texts of the turn's folder (cut logs, attachments, diffs)");
    expect(section).toContain('Without a helper you read yourself');
    expect(section).toContain('The decisions, the actions and the result block are yours');
    expect(section).not.toMatch(/claude|codex|cursor|sonnet|opus|haiku|gpt/i);
    expect(section).not.toMatch(/\b(Task|Agent|Grep|Glob|Bash|Explore)\b/);
  });

  it('lists the pass-on action among the run actions it hands back', () => {
    expect(skill).toContain("pass a run's question to the person");
  });

  it('names the facts of a run and the run commands, with a replay instruction, a rebase and the runs below a task', () => {
    expect(skill).toContain('each failed check command with the end of its output');
    expect(skill).toContain('each failed CI job with the end of its log');
    expect(skill).toContain('replay a run from a step with an instruction');
    expect(skill).toContain('rebase a run');
    expect(skill).toContain("on a task's run or any run below it, such as a part of an epic");
  });

  it('asks `Milestone or backlog?` and records the answer as a decision', () => {
    expect(skill).toContain('`Milestone or backlog?`');
  });

  describe('Questions and decisions', () => {
    const section = skill.split('## Questions and decisions')[1].split('\n## ')[0];

    it('decides what the decision log answers, records it with a reason shown as an info line, and does not wait', () => {
      expect(section).toContain('Decide as `Decide what you hold` says, with what the backlog holds');
      expect(section).toContain('the decision log, the milestone');
      expect(section).toContain('record it as a decision with a one-line reason');
      expect(section).toContain('info line');
      expect(section).toContain('nothing waits for the person');
    });

    it.each(CASES)('asks the person only about: %s', (kind) => {
      expect(section).toContain(
        'only in the cases of `Pass up what you do not hold`: the person is the end of your chain',
      );
      expect(core).toContain(kind);
      expect(skill).not.toContain(kind);
    });

    it('says a run question comes to the planner first and that passing it on is an action with a reason', () => {
      expect(section).toContain("A run's question comes to you first, as an event with the question's id");
      expect(section).toContain('pass it to the person with the pass-on action and a one-line reason');
      expect(section).toContain('A turn that ends with neither passes the question on and says so in the chat');
    });

    it('holds the one guard for a run that fails the same way a third time and none of the three old rules', () => {
      expect(section).toContain(
        'A run that fails the same way a third time on the same tree is stopped, its error left as it is, and reported in the chat; you do not resume, replay or rebase it again.',
      );
      expect(section).not.toContain('blocked again for the same reason');
      expect(section).not.toContain('two of its covering tasks merged');
      expect(section).not.toContain('When two fixes merged');
    });

    it('names no project and no person', () => {
      expect(`${section}${core}`).not.toMatch(/swarmloop|@\w/i);
    });
  });
});
