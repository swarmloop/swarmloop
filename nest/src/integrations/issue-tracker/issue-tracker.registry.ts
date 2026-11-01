import { Injectable } from '@nestjs/common';
import { SwarmloopError } from '../../swarmloop-error';
import { JiraIssueTracker } from './jira/jira-issue-tracker';
import { IssueTracker } from './issue-tracker';

export function createIssueTracker(value: string, jira: IssueTracker): IssueTracker {
  if (value === 'jira') {
    return jira;
  }
  throw new SwarmloopError(`ISSUE_TRACKER has unknown value ${value}`);
}

@Injectable()
export class IssueTrackerRegistry {
  static readonly names = ['jira'] as const;

  constructor(private readonly jira: JiraIssueTracker) {}

  byName(name: string): IssueTracker {
    return createIssueTracker(name, this.jira);
  }
}
