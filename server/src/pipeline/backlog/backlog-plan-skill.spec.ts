import { readFileSync } from 'fs';
import { join } from 'path';

const skill = readFileSync(join(__dirname, '../../../../skills/backlog-plan/SKILL.md'), 'utf8');

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

  it('reads the marks of every merge, whether or not the task covers a requirement, and adds a fix task for a real miss', () => {
    const section = skill.slice(skill.indexOf('## After a merge'), skill.indexOf('## Before anything starts'));
    expect(section).toContain(
      'Whether or not the task covers a milestone requirement, read its marks against its brief',
    );
    expect(section).toContain('`not built:` lines');
    expect(section).toContain('outside its files or its plan');
    expect(section).toContain('A real miss gets a fix task in the same milestone, with a one-line reason in the chat');
    expect(section).toContain('No change is the usual answer.');
  });

  it('hands heavy reading to a helper, rereads the lines a fact rests on, and names no runtime, model or tool', () => {
    const start = skill.indexOf('## Reading with a helper');
    const section = skill.slice(start, skill.indexOf('\n## ', start + 1));
    expect(section).toContain('hand it the heavy reading: code, long briefs, logs and diffs');
    expect(section).toContain('Ask it for the facts you need, each with its file and line');
    expect(section).toContain('Before you act on a fact, read yourself the lines it rests on');
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
      expect(section).toContain('Decide any question whose answer follows from the decision log');
      expect(section).toContain('record it as a decision with a one-line reason');
      expect(section).toContain('info line');
      expect(section).toContain('nothing waits for the person');
    });

    it.each([
      'a new behavior for the product',
      "a change of the milestone's goal, or of an order the person set",
      'money (limits, plans)',
      'what a public repository shows about a person',
      'anything that weakens a project rule (security, a test, CI)',
      'anything you are not sure of',
    ])('asks the person only about: %s', (kind) => {
      expect(section).toContain(kind);
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
      expect(section).not.toMatch(/swarmloop|@\w/i);
    });
  });
});
