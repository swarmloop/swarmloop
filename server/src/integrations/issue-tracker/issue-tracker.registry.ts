import { Injectable } from '@nestjs/common';
import { SwarmloopError } from '../../core/swarmloop-error';
import { JiraIssueTracker } from './jira/jira-issue-tracker';
import type { Connection } from '../connection';
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

  /** How a person connects each tracker that offers a connection. */
  connections(): Connection[] {
    const trackers: IssueTracker[] = [this.jira];
    return trackers.flatMap((tracker) => (tracker.connection ? [tracker.connection] : []));
  }
}
