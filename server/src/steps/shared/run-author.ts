import { Injectable } from '@nestjs/common';
import type { CommitAuthor } from '../../git/git';
import { LEGACY_MACHINE } from '../../contract/people';
import { RunRepository } from '../../history/run.repository';
import { starterOf } from '../../history/run-starter';
import { CodeHostRegistry } from '../../integrations/code-host/code-host.registry';

export type AuthoredRun = Parameters<typeof starterOf>[1] & { codeHost: string };

/** The person every commit of a run is made as: the starter's name and the host's address for their account. */
@Injectable()
export class RunAuthor {
  constructor(
    private readonly runs: RunRepository,
    private readonly registry: CodeHostRegistry,
  ) {}

  /** Null for a run with no person, or whose host gives no address: its commits keep the server's identity. A host outage is not caught. */
  async of(run: AuthoredRun): Promise<CommitAuthor | null> {
    const login = await starterOf(this.runs, run);
    if (!login || login === LEGACY_MACHINE || !this.registry.has(run.codeHost)) {
      return null;
    }
    const host = await this.registry.hostFor({ codeHost: run.codeHost, startedBy: login });
    const { name, email } = await host.readAuthor(login);
    return email ? { name: name ?? login, email } : null;
  }
}
