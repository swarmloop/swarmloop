import { Injectable, Optional } from '@nestjs/common';
import { AppConfig } from '../config/env';
import { Clock } from '../core/clock';
import { HaltedRuns } from '../core/halted-runs';
import { basename } from 'path';
import { git } from '../git/git';
import type { RunEntity } from '../history/entities';
import type { SandboxMount } from '../core/sandbox-mount';
import { checkRun, readEnvironmentConfig } from './environment-config';
import { SwarmloopError } from '../core/swarmloop-error';
import { CheckCommandRepository } from '../history/check-command.repository';
import { DocumentRepository } from '../history/document.repository';
import { LiveHub } from '../live/live.hub';
import { SandboxService } from '../sandbox/sandbox.service';
import type { EnvironmentInput, FailedCommand } from './environment-types';
import { ProjectEnvironments } from './project-environments';

@Injectable()
export class EnvironmentService extends ProjectEnvironments {
  constructor(
    config: AppConfig,
    clock: Clock,
    sandbox: SandboxService,
    private readonly repository: DocumentRepository,
    commands: CheckCommandRepository,
    @Optional() live?: LiveHub,
    @Optional() haltedRuns?: HaltedRuns,
  ) {
    super({
      env: () => config.env,
      clock,
      sandbox,
      documents: repository,
      commands,
      live,
      halted: (key) => haltedRuns?.halted(key) ?? false,
    });
  }

  /** The check commands the run's repositories list, from the environment the run stored. */
  async checkCommands(input: Pick<EnvironmentInput, 'run' | 'key' | 'mounts'>): Promise<Omit<FailedCommand, 'tail'>[]> {
    const found: Omit<FailedCommand, 'tail'>[] = [];
    for (const mount of input.mounts) {
      const record = await this.record({ ...input, mounts: [mount] });
      found.push(...(record?.config.checks ?? []).map((check) => ({ repo: record!.repo, command: checkRun(check) })));
    }
    return found;
  }

  /** The commands of a repository that the paths of its last checks visit skipped. */
  async skippedChecks(key: string, repo: string): Promise<{ names: string[] } | null> {
    const stored = await this.repository.latestBody(key, `checks_skipped:${repo}`);
    return stored ? (JSON.parse(stored) as { names: string[] }) : null;
  }

  /** An explicit rebase adopts the new trusted base environment, never the agent's edited manifest. */
  async refreshAfterRebase(run: RunEntity, mounts: SandboxMount[], bases: ReadonlyMap<string, string>): Promise<void> {
    for (const mount of mounts) {
      const repo = basename(mount.hostPath);
      const selected = bases.get(repo);
      if (!selected) continue;
      const ref = await git(['-C', mount.hostPath, 'rev-parse', '--verify', `${selected}^{commit}`]).catch(() => '');
      if (!ref) throw new SwarmloopError(`${repo}: rebase environment base is missing`);
      const stored = await this.repository.latestBody(run.key, `environment:${repo}`);
      if (stored && (JSON.parse(stored) as { ref?: string } | null)?.ref === ref) continue;
      const config = await readEnvironmentConfig(mount.hostPath, ref);
      const body = JSON.stringify(config ? { repo, ref, config } : null);
      await this.repository.putDocument(run, `environment:${repo}`, body);
      await this.repository.putDocument(run, 'environment', body);
    }
  }
}
