import type { BacklogView } from '@contract/backlog';

type Facts = Record<string, string>;

const PLAIN = 'a task';

/** The title of a task from its slug; a task that is gone is named plainly, never by its slug. */
function titleOf(view: BacklogView, slug: string | undefined): string {
  const found = view.tasks.find((task) => task.slug === slug);
  return found ? `“${found.title}”` : PLAIN;
}

function titlesOf(view: BacklogView, slugs: string | undefined): string {
  const list = (slugs ?? '').split(', ').filter((slug) => slug !== '');
  return list.length > 0 ? list.map((slug) => titleOf(view, slug)).join(', ') : 'tasks';
}

function sentenceFor(view: BacklogView, facts: Facts): string {
  switch (facts.action) {
    case 'create backlog':
      return 'created this backlog';
    case 'propose milestone':
      return `proposed milestone ${facts.milestone}`;
    case 'accept milestone':
      return `accepted milestone ${facts.milestone}`;
    case 'run milestone':
      return `started milestone ${facts.milestone}`;
    case 'run backlog':
      return `started the proposed milestones (${facts.milestones})`;
    case 'add requirements':
      return 'added requirements';
    case 'add repository':
      return `added the repository ${facts.repository}`;
    case 'record decision':
      return 'recorded a decision';
    case 'pause':
      return 'paused the backlog';
    case 'unpause':
      return 'resumed the backlog';
    case 'add tasks':
      return `added ${titlesOf(view, facts.tasks)}`;
    case 'change task':
      return `changed ${titleOf(view, facts.task)}`;
    case 'skip task':
      return `skipped ${titleOf(view, facts.task)}`;
    case 'merge task':
      return `merged ${titleOf(view, facts.task)}`;
    case 'run task now':
      return `ran ${titleOf(view, facts.task)} now`;
    case 'add item':
      return `added ${titleOf(view, facts.task)} to the backlog items`;
    case 'move item':
      return `moved ${titleOf(view, facts.task)} to milestone ${facts.milestone}`;
    case 'drop item':
    case 'delete task':
      return `deleted ${titleOf(view, facts.task)}`;
    default:
      return 'changed the backlog';
  }
}

/** One plain sentence for a by-hand action of the backlog's events: who did what, with task titles in place of slugs. */
export function actionSentence(view: BacklogView, facts: Facts): string {
  return `${facts.who ?? 'Someone'} ${sentenceFor(view, facts)}.`;
}
