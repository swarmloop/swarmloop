import type { AppConfig, SwarmloopEnv } from '../../../config/env';
import type { Clock } from '../../../core/clock';
import { HttpStatusError, request } from '../../http';

const KEY_IN_TEXT = /[A-Z][A-Z0-9]+-\d+/g;

export function jiraConfigured(env: SwarmloopEnv): boolean {
  return Boolean(env.JIRA_BASE_URL && env.JIRA_EMAIL && env.JIRA_API_TOKEN);
}

/** Which key-shaped words in a text are Jira tickets: only with Jira configured, and only for known projects. */
export class JiraTicketKeys {
  /** Whether a project exists on the site, asked once per project key. */
  private readonly projects = new Map<string, Promise<boolean>>();

  constructor(
    private readonly config: AppConfig,
    private readonly clock: Clock,
    private readonly credentials: () => { base: string; headers: Record<string, string> },
  ) {}

  async find(text: string): Promise<string[]> {
    if (!jiraConfigured(this.config.env)) {
      return [];
    }
    const allowed = this.config.env.JIRA_PROJECTS.split(',')
      .map((project) => project.trim())
      .filter(Boolean);
    const found: string[] = [];
    for (const key of new Set(text.match(KEY_IN_TEXT) ?? [])) {
      const project = key.slice(0, key.lastIndexOf('-'));
      if (allowed.length > 0 ? allowed.includes(project) : await this.projectExists(project)) {
        found.push(key);
      }
    }
    return found;
  }

  private projectExists(project: string): Promise<boolean> {
    let known = this.projects.get(project);
    if (!known) {
      known = this.lookupProject(project);
      this.projects.set(project, known);
    }
    return known;
  }

  /** A 404 is an answer and stays cached. Any other failure ignores the project for this call only. */
  private async lookupProject(project: string): Promise<boolean> {
    const { base, headers } = this.credentials();
    let status: number | null = null;
    try {
      const response = await request(
        this.clock,
        `${base}/rest/api/3/project/${encodeURIComponent(project)}`,
        headers,
        [],
      );
      status = response.status;
    } catch (error) {
      status = error instanceof HttpStatusError ? error.status : null;
    }
    if (status !== null && status >= 200 && status < 300) {
      return true;
    }
    if (status !== 404) {
      this.projects.delete(project);
    }
    return false;
  }
}
