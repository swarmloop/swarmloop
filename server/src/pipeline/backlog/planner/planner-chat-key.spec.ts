import { isStateName } from '../../../sandbox/sandbox-launch';
import { plannerChatKey } from './planner-chat-key';

describe('plannerChatKey', () => {
  it('names the planner chat of a backlog by its id, in a form a state folder can carry', () => {
    expect(plannerChatKey(7)).toBe('backlog-7-planner');
    expect(isStateName(plannerChatKey(7))).toBe(true);
  });
});
