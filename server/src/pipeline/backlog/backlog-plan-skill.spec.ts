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

    it('names no project and no person', () => {
      expect(section).not.toMatch(/swarmloop|@\w/i);
    });
  });
});
