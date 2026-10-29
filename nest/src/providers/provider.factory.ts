import { SwarmloopError } from '../swarmloop-error';
import { IssueTracker, RequirementsSource } from './contracts';

export function createIssueTracker(value: string, jira: IssueTracker): IssueTracker {
  if (value === 'jira') {
    return jira;
  }
  throw new SwarmloopError(`ISSUE_TRACKER has unknown value ${value}`);
}

export function createRequirementsSource(
  value: string,
  sources: { agent: RequirementsSource; direct: RequirementsSource },
): RequirementsSource {
  if (value === 'agent') {
    return sources.agent;
  }
  if (value === 'direct') {
    return sources.direct;
  }
  throw new SwarmloopError(`REQUIREMENTS_VIA has unknown value ${value}`);
}
