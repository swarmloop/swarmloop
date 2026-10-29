import { readFileSync } from 'fs';
import { join } from 'path';
import { IMPLEMENT_REVIEW_FOLLOW_UP, implementFollowUp, PLAN_REVIEW_FOLLOW_UP, planFollowUp, reviewContinue, reviewResume, withAddedRepos } from './follow-up';
import { LINKED_CONTEXT, TASK_SCOPE } from './requirements-brief';

const skillText = (name: string): string => readFileSync(join(__dirname, '../../../skills', name, 'SKILL.md'), 'utf8');

// The one code-quality standard every plan and implement turn must carry, word for word,
// so the first turn (SKILL.md) and the resume (follow-up.ts) can never drift apart.
const CODE_STANDARD =
  'Keep to the structure and patterns already in the tree, and keep it clean, simple, and straightforward: DRY, KISS, SOLID. ' +
  'Favor clear, well-factored code over clever or cramped code: each function, module, and layer has one clear responsibility. ' +
  'Reach for an abstraction when it makes the code clearer and matches how the tree is already organized; do not add a file, helper, or layer that does not earn its place or that the task does not need. ' +
  'When a change leaves a component, file, export, import, comment, or commented-out code with no remaining use, remove that leftover in the same change. ' +
  'Keep the behavior complete and reliable: the cases the requirement names work, and errors are handled the way the tree already handles them. ' +
  'Cover the change with tests in the style the tree already uses. ' +
  'Tests run only in the GitLab or GitHub pipeline, never in this sandbox.';

const STEP_PAIRS = [
  { name: 'plan', skill: skillText('plan'), followUp: planFollowUp('') },
  { name: 'plan-review', skill: skillText('plan-review'), followUp: PLAN_REVIEW_FOLLOW_UP },
  { name: 'implement', skill: skillText('implement'), followUp: implementFollowUp('plan:\n- add the field\n', null) },
  { name: 'implement-review', skill: skillText('implement-review'), followUp: IMPLEMENT_REVIEW_FOLLOW_UP },
];

describe('step prompt invariants', () => {
  it('carries the one code-quality standard, word for word, on the first turn and the resume', () => {
    for (const pair of STEP_PAIRS) {
      expect(pair.skill).toContain(CODE_STANDARD);
      expect(pair.followUp).toContain(CODE_STANDARD);
    }
  });

  it('carries the one task scope, word for word, wherever the requirements are read', () => {
    for (const pair of STEP_PAIRS) {
      expect(pair.skill).toContain(TASK_SCOPE);
    }
    for (const followUp of [planFollowUp(''), PLAN_REVIEW_FOLLOW_UP, IMPLEMENT_REVIEW_FOLLOW_UP]) {
      expect(followUp).toContain(TASK_SCOPE);
    }
    for (const name of ['research', 'plan', 'plan-review', 'implement', 'code-review/requirements']) {
      expect(skillText(name)).toContain(LINKED_CONTEXT);
    }
    expect(skillText('code-review/requirements')).toContain(TASK_SCOPE);
    expect(skillText('research')).toContain(TASK_SCOPE);
    for (const text of [skillText('plan-review'), PLAN_REVIEW_FOLLOW_UP]) {
      expect(text).toContain('Check that the checklist covers every behavior the task requires');
    }
    for (const name of ['research', 'plan', 'plan-review', 'implement', 'implement-review', 'code-review/requirements']) {
      expect(skillText(name)).not.toContain('already owns');
      expect(skillText(name)).not.toContain('Only the Work section');
    }
  });

  it('keeps one vocabulary for an out-of-scope item across the plan turns', () => {
    for (const pair of STEP_PAIRS.filter((item) => item.name.startsWith('plan'))) {
      expect(pair.skill).toContain('belongs only to another ticket');
      expect(pair.followUp).toContain('belongs only to another ticket');
    }
    expect(skillText('plan')).not.toContain('belongs only to Context');
  });

  it('asks plan-review for the same sections on the first turn and the resume', () => {
    expect(skillText('plan-review')).toContain('summary:');
    expect(PLAN_REVIEW_FOLLOW_UP).toContain('summary:');
  });
});

const REVIEWERS = ['requirements', 'quality', 'regressions', 'security', 'performance'];
const REVIEW_SCAFFOLD = [
  'Read only that path.',
  'The Diff section names the complete diff.',
  'Do not infer the change from file modification times.',
  'Do not edit files. Do not run git.',
  'On `decision: return`, name one broken behavior in this diff.',
];

describe('code review reviewers', () => {
  it('gives every reviewer the same procedure and output contract', () => {
    for (const name of REVIEWERS) {
      const body = skillText(`code-review/${name}`);
      for (const line of REVIEW_SCAFFOLD) {
        expect(body).toContain(line);
      }
    }
  });
});

describe('withAddedRepos', () => {
  it('appends the note when a repository was added', () => {
    const prompt = withAddedRepos(
      'Do the checklist.',
      'Added repositories:\n- handbook is mounted at /work/handbook.\n',
    );
    expect(prompt).toContain('Do the checklist.');
    expect(prompt).toContain('/work/handbook');
  });

  it('leaves the prompt unchanged when there is no note', () => {
    expect(withAddedRepos('Do the checklist.', null)).toBe('Do the checklist.');
  });
});

describe('return follow-ups', () => {
  it('tells implement to fix the named behavior and the next reviewer not to copy another angle', () => {
    const implement = implementFollowUp('plan:\n- delete the run\n', '## quality\n- stop returns before writers finish\n');
    expect(implement).toContain('Fix the broken behavior named in the return');
    expect(implement).toContain('Do not add a mechanism it did not name');
    expect(implement).not.toContain('A pipeline return is a test that failed on this commit');
    const pipeline = implementFollowUp('plan:\n- delete the run\n', '## pipeline\nresult: fail\njob: test\n');
    expect(pipeline).toContain('A pipeline return is a test that failed on this commit');
    expect(pipeline).toContain('Do not leave the files as they are');
    expect(pipeline).not.toContain('say that behavior now holds');
    expect(implementFollowUp('plan:\n- delete the run\n', null)).not.toContain('Fix the broken behavior');
    expect(IMPLEMENT_REVIEW_FOLLOW_UP).toContain('Do not widen it into a new mechanism');
    expect(IMPLEMENT_REVIEW_FOLLOW_UP).toContain('A pipeline return is a test that failed on this commit');
    expect(IMPLEMENT_REVIEW_FOLLOW_UP).toContain('A change that the failed pipeline job needs is not more than the plan');
    expect(IMPLEMENT_REVIEW_FOLLOW_UP).toContain('end with summary only');
    const review = reviewResume('quality', '- waited for the writers\n- stop no longer returns early', '- left that wait in place');
    expect(review).toContain('This chat is only the quality angle');
    expect(review).toContain('waited for the writers');
    expect(review).toContain('left that wait in place');
    expect(review).toContain('When your last return is already fixed, or it is already what the plan asks, decision: ok');
    expect(review).toContain('A behavior it removes is not a missing requirement');
    expect(review).toContain('A change that makes a failed pipeline job on this branch pass is not extra');
    expect(reviewResume('quality', '- done', '- checked', '- remove the catch-up')).toContain('remove the catch-up');
    expect(reviewResume('quality', '', '')).toContain('- nothing recorded');
    expect(reviewContinue('security')).toContain('You were interrupted before the decision');
    expect(reviewContinue('security')).toContain('Do not start over');
  });
});
