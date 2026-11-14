import { Injectable } from '@nestjs/common';
import { PersonalCredentials } from '../auth/personal-credentials.service';
import { missingCredential, runAgents } from '../config/agents';
import { AppConfig } from '../config/env';
import { UserSettingRepository } from '../history/user-setting.repository';
import type { RuntimeName } from '../integrations/agent-runtime/agent-runtime.registry';
import { missingModelCredential, ok, worst, type Outcome } from './readiness-outcome';

/** The `model-credential` item as one person sees it: their saved agents, else the env lists, with their connections, else env. */
@Injectable()
export class ReadinessModelCredential {
  constructor(
    private readonly config: AppConfig,
    private readonly credentials: PersonalCredentials,
    private readonly settings: UserSettingRepository,
  ) {}

  async outcome(login: string): Promise<Outcome> {
    const saved = await this.settings.read(login);
    const agents = runAgents(this.config.env, { agents: saved?.agents ?? null });
    const runtimes = [...new Set(agents.map((agent) => agent.runtime))];
    return worst(await Promise.all(runtimes.map((runtime) => this.runtime(runtime, login))));
  }

  private async runtime(runtime: RuntimeName, login: string): Promise<Outcome> {
    const found = await this.credentials.runtimeCredential(runtime, login);
    return found
      ? ok(`${found.name} is set for ${runtime}`)
      : missingModelCredential(runtime, missingCredential(runtime));
  }
}
