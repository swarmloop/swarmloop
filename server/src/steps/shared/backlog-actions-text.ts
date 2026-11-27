import { backlogTurn } from '../../agent-result/definitions/backlog-turn';
import { choiceList } from '../../agent-result/result-choices';

/** The skill line that stands for the list of the actions a backlog planner may hand back. */
export const BACKLOG_ACTIONS_MARK = '[backlog actions]';

/** The actions and their fields, written from the definition the server checks the turn's block against. */
export function backlogActionsText(): string {
  return choiceList(backlogTurn, 'actions').join('\n');
}
