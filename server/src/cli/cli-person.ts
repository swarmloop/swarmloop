import { Injectable } from '@nestjs/common';
import { PersonalTokens } from '../auth/personal-tokens.service';
import { AppConfig } from '../config/env';
import type { StoredAgents } from '../contract/api';
import { UserSettingRepository } from '../history/user-setting.repository';

/** The person a CLI command acts for. */
interface CliPerson {
  login: string;
  agents: StoredAgents | null;
}

interface CliRefusal {
  exitCode: 1;
  message: string;
}

const NO_PERSON_MESSAGE =
  'run and step act as a person: create a token in Settings → API tokens (or run `sloop login`) and set SWARMLOOP_TOKEN';

/** Turns `SWARMLOOP_TOKEN` into the person a run or step acts for, or the refusal to print. */
@Injectable()
export class CliPersons {
  constructor(
    private readonly config: AppConfig,
    private readonly tokens: PersonalTokens,
    private readonly settings: UserSettingRepository,
  ) {}

  async resolve(): Promise<CliPerson | CliRefusal> {
    const value = this.config.env.SWARMLOOP_TOKEN;
    const login = value ? await this.tokens.personOf(value) : null;
    if (!login) {
      return { exitCode: 1, message: NO_PERSON_MESSAGE };
    }
    return { login, agents: (await this.settings.read(login))?.agents ?? null };
  }
}

export function isRefusal(result: CliPerson | CliRefusal): result is CliRefusal {
  return 'exitCode' in result;
}
