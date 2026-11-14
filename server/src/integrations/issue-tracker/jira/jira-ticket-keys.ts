import type { AppConfig, SwarmloopEnv } from '../../../config/env';
import type { Clock } from '../../../core/clock';
import { request } from '../../http';
import { HostUnavailable } from '../../../core/swarmloop-error';

const KEY_IN_TEXT = /[A-Z][A-Z0-9]+-\d+/g;

export function jiraConfigured(env: SwarmloopEnv): boolean {
  return Boolean(env.JIRA_BASE_URL && env.JIRA_EMAIL && env.JIRA_API_TOKEN);
}

/** The three Jira values of env, by their env names, when all of them are set: what the form's Test reads for the server default. */
export function jiraEnvFields(env: SwarmloopEnv): Record<string, string> | null {
  return jiraConfigured(env)
    ? { JIRA_BASE_URL: env.JIRA_BASE_URL, JIRA_EMAIL: env.JIRA_EMAIL, JIRA_API_TOKEN: env.JIRA_API_TOKEN }
    : null;
}

/** A Jira site and the login it was resolved for: the login, or `env` for the server's own. */
export interface JiraSite {
  owner: string;
  base: string;
  headers: Record<string, string>;
}

/** Which key-shaped words in a text are Jira tickets: only with Jira configured, and only for known projects. */
export class JiraTicketKeys {
  /** Whether a project exists on a site, asked once per owner and project key. */
  private readonly projects = new Map<string, Promise<boolean>>();

  constructor(
    private readonly config: AppConfig,
    private readonly clock: Clock,
    private readonly resolve: (login?: string | null) => Promise<JiraSite | null>,
  ) {}

  async find(text: string, login?: string | null): Promise<string[]> {
    const site = await this.resolve(login);
    if (!site) {
      return [];
    }
    const allowed = this.config.env.JIRA_PROJECTS.split(',')
      .map((project) => project.trim())
      .filter(Boolean);
    const found: string[] = [];
    for (const key of new Set(text.match(KEY_IN_TEXT) ?? [])) {
      const project = key.slice(0, key.lastIndexOf('-'));
      if (allowed.length > 0 ? allowed.includes(project) : await this.projectExists(site, project)) {
        found.push(key);
      }
    }
    return found;
  }

  private projectExists(site: JiraSite, project: string): Promise<boolean> {
    const id = `${site.owner}\n${project}`;
    let known = this.projects.get(id);
    if (!known) {
      known = this.lookupProject(site, project, id);
      this.projects.set(id, known);
      known.catch(() => this.projects.delete(id));
    }
    return known;
  }

  /** A 404 is an answer and stays cached. Any other failure ignores the project for this call only. */
  private async lookupProject(site: JiraSite, project: string, id: string): Promise<boolean> {
    const { base, headers } = site;
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
      if (error instanceof HostUnavailable) {
        throw error;
      }
    }
    if (status !== null && status >= 200 && status < 300) {
      return true;
    }
    if (status !== 404) {
      this.projects.delete(id);
    }
    return false;
  }
}
