import { SwarmloopError } from '../swarmloop-error';
import { IssueTracker } from './contracts';

export function createIssueTracker(value: string, jira: IssueTracker): IssueTracker {
  if (value === 'jira') {
    return jira;
  }
  throw new SwarmloopError(`ISSUE_TRACKER has unknown value ${value}`);
}
