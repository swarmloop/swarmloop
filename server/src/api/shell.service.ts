import { realpathSync } from 'fs';
import { join, resolve, sep } from 'path';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Clock } from '../core/clock';
import { RunEntity } from '../history/entities';
import { DocumentRepository } from '../history/document.repository';
import { FlowRepository } from '../history/flow.repository';
import { root } from '../history/run-paths';
import { RunRepository } from '../history/run.repository';
import { VisitRepository } from '../history/visit.repository';
import { AppConfig } from '../config/env';
import { assertKey } from '../core/pipeline-result';
import { PHASES } from '../contract/steps';
import { CHAT_LOCK, containerLockBody, readChatLock } from '../pipeline/chat-lock';
import { settleShell } from '../pipeline/shell-lock';
import { mountsForRun } from '../sandbox/sandbox-launch';
import { SandboxService } from '../sandbox/sandbox.service';
import {
  parseResume,
  parseSnapshot,
  restoreTree,
  SHELL_RESUME,
  SNAPSHOT,
  snapshotRun,
} from '../pipeline/worktree-snapshot';
import { RewindView, ShellFeature, ShellMatch, ShellStatusView, SnapshotsView } from '../contract/api';

interface FeatureRow {
  key: string;
  targetPath: string | null;
}

function covers(featurePath: string, cwd: string): boolean {
  const base = resolve(featurePath);
  const here = resolve(cwd);
  return here === base || here.startsWith(`${base}${sep}`);
}

function samePlace(featurePath: string, cwd: string): boolean {
  try {
    return covers(realpathSync(featurePath), realpathSync(cwd));
  } catch {
    return covers(featurePath, cwd);
  }
}

export function matchFeatures<T extends FeatureRow>(runs: T[], cwd: string, root: string): T[] {
  return runs.filter((run) => {
    const paths = [join(root, 'worktrees', run.key)];
    if (run.targetPath) {
      paths.push(run.targetPath);
    }
    return paths.some((path) => samePlace(path, cwd));
  });
}

@Injectable()
export class ShellService {
  constructor(
    private readonly runs: RunRepository,
    private readonly documents: DocumentRepository,
    private readonly visits: VisitRepository,
    private readonly flows: FlowRepository,
    private readonly config: AppConfig,
    private readonly sandbox: SandboxService,
    private readonly clock: Clock,
  ) {}

  async open(path: string): Promise<ShellFeature | { matches: ShellMatch[] }> {
    const cwd = path.trim();
    if (!cwd) {
      throw new BadRequestException('path is missing');
    }
    const matches = matchFeatures(await this.runs.listRuns(), cwd, root(this.config));
    if (matches.length > 1) {
      return {
        matches: matches.map((run) => ({ key: run.key, status: run.status, currentStep: run.currentStep })),
      };
    }
    if (matches.length === 1) {
      return this.view(await settleShell(this.runs, this.documents, this.sandbox, matches[0], this.clock), false);
    }
    const key = `run-${this.clock.now().toString(36)}`;
    const created = await this.runs.openWaiting(key, cwd);
    await this.flows.noteFlow(key, PHASES, null);
    return this.view(created, true);
  }

  async describe(key: string): Promise<ShellFeature> {
    return this.view(await this.ready(key), false);
  }

  async lock(key: string, container: string): Promise<ShellStatusView> {
    const name = container.trim();
    if (!/^[a-z0-9][a-z0-9_.-]+$/.test(name)) {
      throw new BadRequestException('container is missing');
    }
    const run = await this.ready(key);
    if (run.status === 'running') {
      throw new ConflictException(`${key} is already running`);
    }
    if (!/^(waiting|blocked|failed|done)$/.test(run.status)) {
      throw new ConflictException(`${key} is already running`);
    }
    await this.documents.putDocument(run, CHAT_LOCK, containerLockBody(run.status, name, this.clock.now()));
    run.status = 'running';
    run.ownerPid = null;
    await this.runs.saveRun(run);
    return { status: 'running' };
  }

  async unlock(key: string): Promise<ShellStatusView> {
    const run = await this.find(key);
    const lock = readChatLock(await this.documents.latestBody(key, CHAT_LOCK));
    if (!lock?.container) {
      return { status: run.status };
    }
    await snapshotRun(
      { documents: this.documents, visits: this.visits, root: root(this.config) },
      this.clock,
      run,
      run.currentStep,
      '',
    );
    run.status = lock.status;
    run.ownerPid = null;
    await this.runs.saveRun(run);
    await this.documents.putDocument(run, CHAT_LOCK, 'clear\n');
    return { status: run.status };
  }

  async snapshots(key: string): Promise<SnapshotsView> {
    const run = await this.find(key);
    const rows = await this.documents.listDocuments(run.id);
    const snapshots = rows
      .filter((row) => row.kind === SNAPSHOT)
      .map((row) => {
        const parsed = parseSnapshot(row.body);
        return { id: row.id, step: parsed.step, at: parsed.at };
      });
    return { snapshots };
  }

  async rewind(key: string, id: number): Promise<RewindView> {
    const run = await this.ready(key);
    if (run.status === 'running') {
      throw new ConflictException(`${key} is already running`);
    }
    if (!Number.isInteger(id)) {
      throw new BadRequestException('snapshot is missing');
    }
    const rows = await this.documents.listDocuments(run.id);
    const row = rows.find((item) => item.id === id && item.kind === SNAPSHOT);
    if (!row) {
      throw new NotFoundException('snapshot is missing');
    }
    const parsed = parseSnapshot(row.body);
    try {
      for (const repo of parsed.repos) {
        await restoreTree(repo.repo, repo.head, repo.tree);
      }
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'rewind failed');
    }
    run.currentStep = parsed.step || run.currentStep;
    run.status = 'waiting';
    run.ownerPid = null;
    await this.runs.saveRun(run);
    const resume = parsed.chat ? `step: ${parsed.step}\nchat: ${parsed.chat}\n` : 'clear\n';
    await this.documents.putDocument(run, SHELL_RESUME, resume);
    return { step: run.currentStep };
  }

  private async ready(key: string): Promise<RunEntity> {
    const run = await this.find(key);
    return settleShell(this.runs, this.documents, this.sandbox, run, this.clock);
  }

  private async find(key: string): Promise<RunEntity> {
    try {
      assertKey(key);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'key is invalid');
    }
    const run = await this.runs.findRun(key);
    if (!run) {
      throw new NotFoundException(`${key} is missing`);
    }
    return run;
  }

  private async view(run: RunEntity, created: boolean): Promise<ShellFeature> {
    const mounts = mountsForRun(join(root(this.config), 'worktrees', run.key), run.targetPath);
    return {
      key: run.key,
      created,
      status: run.status,
      currentStep: run.currentStep,
      runtime: run.runtime,
      resumeChatId: await this.resumeChat(run),
      mounts: mounts.map((mount) => ({ hostPath: mount.hostPath, containerPath: mount.containerPath })),
    };
  }

  private async resumeChat(run: RunEntity): Promise<string | null> {
    const saved = parseResume(await this.documents.latestBody(run.key, SHELL_RESUME));
    if (saved && saved.step === run.currentStep) {
      return saved.chat;
    }
    return null;
  }
}
