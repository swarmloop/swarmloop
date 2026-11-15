import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { registerSecretSource } from '../../core/secret-sources';
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
export class IssueTrackerRegistry implements OnModuleInit, OnModuleDestroy {
  static readonly names = ['jira'] as const;

  private unregisterSecrets: (() => void) | undefined;

  constructor(private readonly jira: JiraIssueTracker) {}

  onModuleInit(): void {
    this.unregisterSecrets = registerSecretSource(() =>
      this.trackers().flatMap((tracker) => tracker.secrets?.() ?? []),
    );
  }

  onModuleDestroy(): void {
    this.unregisterSecrets?.();
  }

  byName(name: string): IssueTracker {
    return createIssueTracker(name, this.jira);
  }

  /** How a person connects each tracker that offers a connection. */
  connections(): Connection[] {
    return this.trackers().flatMap((tracker) => (tracker.connection ? [tracker.connection] : []));
  }

  private trackers(): IssueTracker[] {
    return [this.jira];
  }
}
