import { Injectable, Optional } from '@nestjs/common';
import { basename } from 'path';
import { AppConfig } from '../../config/env';
import { Clock } from '../../core/clock';
import { loopMark, type PipelineResult, type StepOptions } from '../../core/pipeline-result';
import type { StepName } from '../../contract/steps';
import { DocumentRepository } from '../../history/document.repository';
import type { DocumentDraft } from '../../history/visit';
import { FlowRepository } from '../../history/flow.repository';
import { root } from '../../history/run-paths';
import { RunRepository } from '../../history/run.repository';
import { VisitRepository } from '../../history/visit.repository';
import { LiveHub } from '../../live/live.hub';
import { worktreeSnapshot } from '../../git/worktree-git';
import { createVerifyLog } from '../../verify/verify-log';
import { imageName } from '../../verify/verify-image';
import { VerifyService, type VerifyResult } from '../../verify/verify.service';
import { BaseStep, type StepContext } from '../base-step';
import { baseRef } from '../code-review/review-diff';
import { VERIFY_RETURN_PREFIX } from '../follow-up';
import { textDocument } from '../shared/handoff';
import { mountsForStep, repoNames } from '../shared/repo-names';
import { storedPlan } from '../step';
import { baseManifest } from './verify-note';
import { latestVerifyLog, parseVerifyLog, renderVerifyLog, snapshotId, type VerifyRecord } from './verify-record';

type Ran = Exclude<VerifyResult, { status: 'skipped' }>;
type Failed = { name: string; worktree: string; result: Ran };

const SKIPPED = 'verify skipped: no .swarmloop.json';

/** Runs the project checks from `.swarmloop.json` between implement-improve and code-review. Writes only `verify_log` and `return`. */
@Injectable()
export class VerifyStep extends BaseStep {
  readonly name: StepName = 'verify';
  readonly requiredKind = 'plan';

  constructor(
    runs: RunRepository,
    documents: DocumentRepository,
    visits: VisitRepository,
    flows: FlowRepository,
    clock: Clock,
    config: AppConfig,
    private readonly verifier: VerifyService,
    @Optional() private readonly live?: LiveHub,
  ) {
    super(runs, documents, visits, flows, clock, config);
  }

  override missingInput(key: string): Promise<string | null> {
    return storedPlan(this.documents, key);
  }

  protected async run(key: string, _options: StepOptions, ctx: StepContext): Promise<PipelineResult> {
    const { opened } = ctx;
    const names = repoNames((await this.documents.latestBody(key, 'repos')) ?? '');
    const mounts = mountsForStep(root(this.config), key, names, opened.run.targetPath);
    const documents = await this.documents.listDocuments(opened.run.id);
    const previous = latestVerifyLog(documents);
    const before = previous ? snapshotId(await worktreeSnapshot(mounts)) : '';
    if (previous?.result === 'pass' && previous.snapshot === before) {
      return this.finish(ctx, 'ok', 'verify passed on this exact tree already');
    }
    const log = createVerifyLog({
      live: this.live,
      clock: this.clock,
      root: root(this.config),
      key,
      label: 'gate',
    });
    const ran: { name: string; commands: string[] }[] = [];
    let failed: Failed | null = null;
    for (const mount of mounts) {
      const name = basename(mount.hostPath);
      const base = await baseRef(mount.hostPath);
      const result: VerifyResult = base
        ? await this.verifier.run({
            runKey: key,
            project: name,
            worktree: mount.hostPath,
            baseRef: base,
            onOutput: log.onOutput,
          })
        : { status: 'skipped' };
      if (result.status === 'skipped') {
        continue;
      }
      if (result.status === 'ok') {
        ran.push({ name, commands: result.commands.map((item) => item.command) });
        continue;
      }
      failed = { name, worktree: mount.hostPath, result };
      break;
    }
    if (!failed && ran.length === 0) {
      return this.finish(ctx, 'ok', SKIPPED);
    }
    await log.finish(failed ? 1 : 0);
    if (failed?.result.status === 'error') {
      return this.finish(ctx, 'failed', failed.result.message ?? 'verify failed');
    }
    const after = snapshotId(await worktreeSnapshot(mounts));
    if (!failed) {
      const record: VerifyRecord = {
        result: 'pass',
        snapshot: after,
        commands: ran.flatMap((item) => item.commands),
        exitCode: null,
        tail: '',
      };
      const commands = record.commands.map((command) => `$ ${command}`).join('\n');
      return this.finish(ctx, 'ok', `verify passed\n${commands}`, [
        textDocument('verify_log', renderVerifyLog(record, this.clock.now() - opened.started)),
      ]);
    }
    return this.failed(ctx, failed, { before, after, previous, documents, names: names.length });
  }

  /** A check failed: send the run back to implement with the real output, unless it cannot help. */
  private async failed(
    ctx: StepContext,
    failed: Failed,
    seen: { before: string; after: string; previous: VerifyRecord | null; documents: DocumentLike[]; names: number },
  ): Promise<PipelineResult> {
    const { opened } = ctx;
    const { result } = failed;
    const command = result.commands.find((item) => item.exitCode !== 0);
    const tail = command?.tail ?? '';
    const record: VerifyRecord = {
      result: 'fail',
      snapshot: seen.after,
      commands: command ? [command.command] : [],
      exitCode: command?.exitCode ?? null,
      tail: command ? tail : (result.message ?? ''),
    };
    const documents = [textDocument('verify_log', renderVerifyLog(record, result.durationMs))];
    const output = this.report(failed, seen.names, result, command?.command, command?.exitCode, record.tail);
    const same =
      seen.previous?.result === 'fail' &&
      seen.previous.snapshot === seen.before &&
      seen.previous.commands.join('\n') === record.commands.join('\n') &&
      seen.previous.tail === record.tail;
    if (same) {
      return this.finish(ctx, 'blocked', `verify failed twice with no change\n${output}`, documents);
    }
    const mark = loopMark(await this.documents.latestBody(opened.run.key, 'loop_mark'));
    const returns = seen.documents.filter(
      (item) => item.kind === 'verify_log' && item.stepStatId > mark && parseVerifyLog(item.body)?.result === 'fail',
    ).length;
    if (returns >= this.config.env.MAX_VERIFY_RETURNS) {
      return this.finish(ctx, 'blocked', `verify return limit reached\n${output}`, documents);
    }
    const image = await this.image(failed);
    documents.push(textDocument('return', `${VERIFY_RETURN_PREFIX}${image}, not in your container)\n${output}\n`));
    return this.finish(ctx, 'waiting', `verify failed\n${output}`, documents, 'implement');
  }

  /** The failing command, its exit code and its tail, as the agent and the person read them. */
  private report(
    failed: Failed,
    repos: number,
    result: Ran,
    command: string | undefined,
    exitCode: number | undefined,
    tail: string,
  ): string {
    const created = /verify created files that git does not ignore.*$/.exec(result.message ?? '')?.[0];
    return [
      ...(repos > 1 ? [`repo: ${failed.name}`] : []),
      ...(command === undefined ? [] : [`command: ${command}`, `exit code: ${exitCode}`]),
      ...(command === undefined || !created ? [] : [created]),
      tail,
    ]
      .filter((line) => line !== '')
      .join('\n');
  }

  private async image(failed: Failed): Promise<string> {
    const manifest = await baseManifest(failed.worktree);
    return manifest ? imageName(manifest, failed.name) : 'the project image';
  }

  private finish(
    ctx: StepContext,
    outcome: 'ok' | 'failed' | 'blocked' | 'waiting',
    text: string,
    documents?: DocumentDraft[],
    moveTo?: 'implement',
  ): Promise<PipelineResult> {
    return ctx.end({
      outcome,
      exitCode: outcome === 'ok' || outcome === 'waiting' ? 0 : 1,
      line: `${ctx.opened.startedAt} ${text}`,
      moveTo,
      visit: documents ? { documents } : undefined,
    });
  }
}

interface DocumentLike {
  kind: string;
  body: string;
  stepStatId: number;
}
