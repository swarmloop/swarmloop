import { existsSync } from 'fs';
import { lstat, readFile, writeFile } from 'fs/promises';
import { basename, join } from 'path';
import { Injectable } from '@nestjs/common';
import type { SandboxMount } from '../../core/sandbox-mount';
import { SwarmloopError } from '../../core/swarmloop-error';
import { readEnvironmentConfig, SWARMLOOP_FILE } from '../../environment/environment-config';
import type { GitRules } from '../../agent-result/definitions/git-change';

/** The only writer of learned git rules: it puts them into the `git` section of each repository's `.swarmloop.json`. */
@Injectable()
export class GitRulesWriter {
  /** The writes to one file, one after another. */
  private readonly queues = new Map<string, Promise<void>>();

  /**
   * Writes the rules into every repository of the mounts. A repository with only a devcontainer gets no file: the
   * returned text says which lines to add there. Empty when every repository took the rules or there were none.
   */
  async write(mounts: SandboxMount[], rules: GitRules | undefined): Promise<string> {
    const entries = Object.entries((rules ?? {}) as Record<string, string | undefined>).filter(([, template]) =>
      template?.trim(),
    );
    if (entries.length === 0) {
      return '';
    }
    const learned = Object.fromEntries(entries) as GitRules;
    const notes = await Promise.all(mounts.map((mount) => this.writeOne(mount, learned)));
    return notes.filter(Boolean).join('\n\n');
  }

  private async writeOne(mount: SandboxMount, rules: GitRules): Promise<string> {
    const file = join(mount.hostPath, SWARMLOOP_FILE);
    await refuseLink(file);
    if (!existsSync(file) && (await readEnvironmentConfig(mount.hostPath))) {
      return noteFor(mount, rules);
    }
    const previous = this.queues.get(file) ?? Promise.resolve();
    const done = previous.then(() => merge(file, rules));
    this.queues.set(
      file,
      done.catch(() => undefined),
    );
    await done;
    return '';
  }
}

/** The agent owns the worktree: a link in place of the file would send the write outside it, so none is followed. */
async function refuseLink(file: string): Promise<void> {
  const found = await lstat(file).catch(() => null);
  if (found?.isSymbolicLink()) {
    throw new SwarmloopError(`${basename(file)} is a symbolic link, so the git rules cannot be added to it`);
  }
}

async function merge(file: string, rules: GitRules): Promise<void> {
  const manifest = existsSync(file) ? parse(file, await readFile(file, 'utf8')) : { version: 1 };
  const git = manifest.git && typeof manifest.git === 'object' ? (manifest.git as Record<string, unknown>) : {};
  await writeFile(file, `${JSON.stringify({ ...manifest, git: { ...git, ...rules } }, null, 2)}\n`);
}

function parse(file: string, text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // Reported below with the file name.
  }
  throw new SwarmloopError(`${basename(file)} is not a JSON object, so the git rules cannot be added to it`);
}

function noteFor(mount: SandboxMount, rules: GitRules): string {
  const where = mount.containerPath === '/work' ? '' : ` of ${basename(mount.containerPath)}`;
  const lines = Object.entries(rules).map(
    ([name, template]) => `    ${JSON.stringify(name)}: ${JSON.stringify(template)}`,
  );
  return `Add to the "git" section of ${SWARMLOOP_FILE}${where}:\n${lines.join(',\n')}`;
}
