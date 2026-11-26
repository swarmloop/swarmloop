import { access, stat } from 'fs/promises';
import { constants } from 'fs';
import { join } from 'path';
import { Injectable } from '@nestjs/common';
import { AppConfig } from '../config/env';
import { root } from '../history/run-paths';
import { sandboxUserId } from '../sandbox/sandbox-launch';
import { SandboxService } from '../sandbox/sandbox.service';
import { ok, worst, type Outcome } from './readiness-outcome';

/** The `paths` item: the folders a run uses are writable by the sandbox user and visible to the Docker daemon. */
@Injectable()
export class ReadinessPaths {
  constructor(
    private readonly config: AppConfig,
    private readonly sandbox: SandboxService,
  ) {}

  async outcome(): Promise<Outcome> {
    const base = root(this.config);
    const owners = new Set([sandboxUserId(), process.getuid?.() ?? 0]);
    const dirs = ['data', 'worktrees'].map((name) => join(base, name));
    const outcomes: Outcome[] = [];
    for (const dir of dirs) {
      outcomes.push(await this.writable(dir, owners));
    }
    const mapped = [...dirs, ...(this.config.env.CHECKOUTS_ROOT ? [this.config.env.CHECKOUTS_ROOT] : [])];
    for (const dir of mapped) {
      outcomes.push(await this.daemonVisible(dir));
    }
    return worst(outcomes, outcomes.some((outcome) => outcome.status === 'fail') ? 'not writable' : 'writable');
  }

  /** A directory the sandbox can use is writable and owned by the server user or the user the sandbox runs as. */
  private async writable(dir: string, owners: Set<number>): Promise<Outcome> {
    const fix = `chown the directory to uid ${[...owners].join(' or ')} and make it writable`;
    try {
      await access(dir, constants.W_OK);
      if (!owners.has((await stat(dir)).uid)) {
        return { status: 'fail', line: `${dir} has another owner`, short: 'not writable', action: fix };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return ok(`${dir} is created on the first run`, 'writable');
      }
      return { status: 'fail', line: `${dir} is not writable`, short: 'not writable', action: fix };
    }
    return ok(`${dir} is writable`, 'writable');
  }

  private async daemonVisible(dir: string): Promise<Outcome> {
    const place = await this.sandbox.daemonPlace(dir);
    if ('volume' in place) {
      const subpath = place.subpath ? `, subpath ${place.subpath}` : '';
      return ok(`${dir} is volume ${place.volume} for the daemon${subpath}`, 'writable');
    }
    if (!place.path) {
      return {
        status: 'fail',
        line: `${dir} has no path the Docker daemon can see`,
        short: 'not writable',
        action: 'mount the directory from the host and mount the Docker socket',
      };
    }
    return ok(`${dir} is ${place.path} for the daemon`, 'writable');
  }
}
