import { readFileSync } from 'fs';
import { join } from 'path';

import { BACKLOG_ACTIONS_MARK, backlogActionsText } from '../../steps/shared/backlog-actions-text';
import { plannerCore } from '../../steps/shared/planner-core';
import { READING_WITH_A_READER_MARK } from '../../steps/shared/reader-asking';
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

const BRIEF_SECTIONS = [
  'Rules',
  'Carries out',
  'Do',
  'Must keep',
  'Out of scope',
  'Behavior change',
  'Pipeline',
  'Check',
];

const REVISION_SENTENCE =
  "Every `changeTask` and `deleteTask` names the task's revision as your brief shows it. Change a task once per answer, with all the fields you change. A task that changed since your brief is refused, and the refusal shows the task as it is now: decide again on that.";

describe('the backlog-plan skill', () => {
  it('says how a change names the revision its brief showed, in its own part and not in the core', () => {
    expect(skill).toContain(REVISION_SENTENCE);
    expect(core).not.toContain('revision');
  });

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

  it("says that a run whose red is its repository's red main waits for a green main after its fix task", () => {
    expect(skill).toContain(
      "When a run's red is its repository's red main, add or keep that fix task, then answer the run: the run waits for a green main and goes on by itself.",
    );
  });

  it('says that what arrives while a turn runs comes once, in the same chat, and asks for the whole answer again', () => {
    const start = skill.split('\n\n').find((paragraph) => paragraph.startsWith('You keep one chat'));
    expect(start).toContain(
      'Messages and events that arrive while you work come to you once, in the same chat, before your answer is applied; give your whole answer again, taking them in.',
    );
    expect(core).not.toContain('arrive while you work');
  });

  it('says a failed or blocked task line carries its reason, which the planner decides on before it asks the person', () => {
    const start = skill.split('\n\n').find((paragraph) => paragraph.startsWith('You keep one chat'));
    expect(start).toContain(
      'the reason of a failed or blocked run (its stored reason, or else the last line of the step it stopped at)',
    );
    expect(skill).toContain(
      'A task line of a failed or blocked run carries its reason. Decide on that reason with the actions you have',
    );
    expect(skill).toContain(
      'Ask the person only when no action of yours can act on it; the question names the reason and what was tried.',
    );
  });

  it('keeps decisions short and puts what a task must change into its brief', () => {
    const section = skill.slice(skill.indexOf('## Questions and decisions'));
    expect(section).toContain('A decision is one or two sentences: what was decided and why.');
    expect(section).toContain("What a task must change goes into that task's brief, not into a decision.");
  });

  it('says the planner keeps one chat, and where the full briefs and all decisions are', () => {
    const start = skill.split('\n\n').find((paragraph) => paragraph.startsWith('You keep one chat'));
    expect(start).toContain('/work/brief/tasks/<slug>.md');
    expect(start).toContain('/work/brief/decisions.md');
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

  it('writes a brief by the brief rule: goal, rule carried out, scope and check, by name and never by line', () => {
    expect(skill).not.toMatch(/`Today`/);
    expect(skill).toContain('never by line number');
    expect(skill).toContain("because each run's research step reads the code as it is when the run starts");
    expect(skill).toContain('are not rewritten');
    expect(skill).toContain(
      'the facts you were given are named by their file and mechanism without a line, and this replaces the file and line that `A new task or a plan change` asks for',
    );
    expect(skill).toContain('the rule it carries out, what is out of scope and how the result is checked');
  });

  it('says a turn has no git and that a proof is something its own run can check', () => {
    const section = skill.slice(
      skill.indexOf('## How a milestone is planned'),
      skill.indexOf('## The brief of a task'),
    );
    expect(section).toContain(
      'A turn has no git: you and your readers read the worktrees as files, without history, log or diff.',
    );
    expect(section).toContain(
      "A task's proof is something its own run can check: a test, a check command or a CI job of its repository.",
    );
  });

  it('offers a start with a button on its message, in one line, and never asks for a reply', () => {
    expect(skill).toContain('A milestone, the backlog or a task starts only when the owner starts it.');
    expect(skill).toContain(
      'add `offerRun` with the proposed milestone or the task: its button shows on your message, and one click starts it.',
    );
    expect(skill).toContain(
      'Say the offer in one line, for example that the button is below. Never ask whether to run it and never wait for a reply',
    );
    expect(skill).not.toContain('one short question whether to run it');
  });

  it('keeps the waiting briefs as they are after a merge unless their goal, rule or scope changes', () => {
    const section = skill.slice(skill.indexOf('## After a merge'), skill.indexOf('## Before anything starts'));
    expect(section).not.toContain('Bring their `Today` up to date');
    expect(section).toContain('A waiting brief changes only when what landed changes its goal, its rule or its scope.');
    expect(section).toContain('Drop or merge a task the merge made unnecessary');
  });

  it('takes the shared text for reading with a reader by its mark, and holds no reading rule of its own', () => {
    expect(skill.split('\n')).toContain(READING_WITH_A_READER_MARK);
    expect(skill).not.toContain('Reading with a helper');
    expect(skill).not.toContain('the launch holds you to it');
    expect(skill).not.toContain('A fact checked by its quote');
  });

  it('takes the action list from the definition by its mark, once, and names no field the definition lacks', () => {
    expect(skill.split('\n').filter((line) => line === BACKLOG_ACTIONS_MARK)).toHaveLength(1);
    expect(prompt).toContain(backlogActionsText());
    const section = skill.slice(skill.indexOf('## What you hand back'));
    expect(section).not.toMatch(/\b(kind|slug|dependsOn)\b/);
  });

  it('lists the pass-on, replay and rebase actions and the runs below a task from the definition', () => {
    expect(prompt).toContain("pass a run's question to the person");
    expect(prompt).toContain('replay a run from a step with an instruction');
    expect(prompt).toContain('- rebase needs: run (string)');
    expect(prompt).toContain("a task's run or any run below it, such as a part of an epic");
  });

  it('names the facts of a run that the planner is given', () => {
    expect(skill).toContain('each failed check command with the end of its output');
    expect(skill).toContain('each failed CI job with the end of its log');
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

  it('accepts a milestone whose tasks are all merged or skipped and whose requirements are closed, with none included', () => {
    expect(skill).toContain(
      "When the active milestone's work is done (every task merged or skipped and every requirement closed, a milestone with no requirements included)",
    );
    expect(skill).toContain('Accept it in that turn with `acceptMilestone`');
  });
});
