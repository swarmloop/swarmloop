import type { Logger } from '@nestjs/common';
import type { AppConfig } from '../config/env';
import { credentialFor, missingCredential } from '../config/agents';
import type { PersonalCredentials } from '../auth/personal-credentials.service';
import type { RunRepository } from '../history/run.repository';
import { starterOf } from '../history/run-starter';
import { StepStopped } from './step-stopped';
import { resolveRepoRoot } from '../config/repo-root';
import type { LiveHub } from '../live/live.hub';
import type { Clock } from '../core/clock';
import { AwakeTime, SAMPLE_MS } from '../core/awake-time';
import type { AgentRuntime, AgentTools } from '../integrations/agent-runtime/agent-runtime';
import type { RuntimeName } from '../integrations/agent-runtime/agent-runtime.registry';
import { modelApiHosts } from '../sandbox/sandbox-launch';
import type { SandboxService } from '../sandbox/sandbox.service';
import type { AgentRunInput as BaseAgentRunInput } from './agent-run-input';
import type { AgentRunResult } from './agent-result';
import type { KillReason } from './limits';
import type { RunStop } from './run-stop';
import { loadPriceTable } from './prices';
import { recordLaunch } from './agent-launches';
import { readOnlyTree } from './agent-args';
import type { AgentLaunchEnv } from './agent-launch-env';
import type { AgentLaunchPrep } from './agent-launch-prep';
import { AgentProcess } from './agent-process';
import { SessionWrites } from './session-writes';
import { AttemptMeter } from './agent-attempt';
import { NO_USAGE } from './since-recorded';
import { OutputTail } from './output-tail';
import { LimitGuard } from './limit-guard';
import { SERVER_PAUSE_NOTE } from '../contract/server-pause';
import { AttemptLog } from './live-output';
import { StartHold } from './start-hold';
import { containerSampler } from '../sandbox/container-sampler';

type LaunchInput = BaseAgentRunInput & { tools: AgentTools };

/** One agent launch: spawn the process, stream it, guard its limits, log it, keep its session and return its result. */
export class AgentLaunch {
  constructor(
    private readonly config: AppConfig,
    private readonly clock: Clock,
    private readonly sandbox: SandboxService,
    private readonly runStop: RunStop,
    private readonly logger: Logger,
    private readonly launchPrep: AgentLaunchPrep,
    private readonly launchEnv: AgentLaunchEnv,
    private readonly live?: LiveHub,
    private readonly credentials?: PersonalCredentials,
    private readonly runs?: RunRepository,
  ) {}

  /**
   * The credential this launch runs with: the given login's own, else the run's starter's own, else the server's env. With none the run stops, as a
   * Stop does, and says which runtime is missing: the person may have disconnected after the run was created.
   */
  async credentialOf(
    key: string,
    runtime: RuntimeName,
    login?: string | null,
  ): Promise<{ name: string; value: string; owner: string | null }> {
    if (!this.credentials || (login === undefined && !this.runs)) {
      return { ...credentialFor(this.config.env, runtime), owner: null };
    }
    const starter = login === undefined ? await this.starterOfRun(key) : login;
    const found = await this.credentials.runtimeCredential(runtime, starter);
    if (!found) {
      this.runStop.halt(key);
      throw new StepStopped([], missingCredential(runtime), null);
    }
    return found;
  }

  private async starterOfRun(key: string): Promise<string | null> {
    const run = await (this.runs as RunRepository).findRun(key);
    return run ? starterOf(this.runs as RunRepository, run) : null;
  }

  /** One launch of the process: spawn it, read its stream until it exits, and return what it did. */
  async once(
    input: LaunchInput,
    runtime: AgentRuntime,
    resumed: boolean,
    priorOutput: string,
  ): Promise<AgentRunResult> {
    const env = this.config.env;
    const credential = await this.credentialOf(input.runKey, runtime.name, input.login);
    const launch = this.launchPrep.prepare(input, runtime, resumed);
    const tmp = await this.launchPrep.runTmp(input);
    const prices = await loadPriceTable(resolveRepoRoot(env.SWARMLOOP_ROOT, __dirname), runtime.name, this.clock.now());
    let started = this.clock.now();
    let awake = new AwakeTime(this.clock, SAMPLE_MS);
    const hold = new StartHold(input.onStartWait);
    const workMounts = readOnlyTree(runtime.name, input.mode)
      ? input.mounts.map((mount) => ({ ...mount, readonly: true }))
      : input.mounts;
    const step = input.liveStep ?? input.step;
    const onPaused = (): void => {
      hold.waits();
      this.live?.changed(input.runKey);
      this.live?.log({ key: input.runKey, step, body: `${SERVER_PAUSE_NOTE}\n` });
    };
    const onWait = (text: string): void => {
      hold.waits();
      this.live?.changed(input.runKey);
      this.live?.log({ key: input.runKey, step, body: `${text}\n` });
    };
    const process = await AgentProcess.spawn(
      this.sandbox,
      {
        runtime: runtime.name,
        runKey: input.runKey,
        step: input.step,
        attemptId: input.attemptId,
        mounts: [...workMounts, ...launch.mounts],
        statePath: launch.statePath,
        allowHosts: [...new Set([...(input.allowHosts ?? []), ...modelApiHosts(runtime.name)])],
        manifestHosts: input.manifestHosts,
        env: [await this.launchEnv.credential(runtime.name, credential, env)],
        command: [runtime.command, ...launch.args],
        unsetEnv: launch.unsetEnv,
        userId: launch.userId,
        ...(input.project ? { project: input.project } : {}),
        ...tmp,
      },
      { onPaused, agent: { step, onWait } },
    ).finally(() => hold.spawned());
    if (hold.wasHeld) {
      // The wait for the pause to end or for an agent place is neither the visit's time nor a host suspension.
      started = this.clock.now();
      awake = new AwakeTime(this.clock, SAMPLE_MS);
      this.live?.changed(input.runKey);
    }
    const baseline =
      priorOutput.length === 0 || priorOutput.endsWith('\n')
        ? `${priorOutput}process started\n`
        : `${priorOutput}\nprocess started\n`;
    const meter = new AttemptMeter({
      model: input.model,
      prices,
      prior: input.prior ?? NO_USAGE,
    });
    const log = new AttemptLog(input.outputFile, input.runKey, step, baseline, () => meter.billed(), this.live);
    const sessionWrites = new SessionWrites(input.sessionFile, runtime.name);
    try {
      await recordLaunch(input.outputFile, input.runKey, step);
      await log.begin();
      const sessionUsd = (): number => (input.chatSpentUsd ?? 0) + meter.billed().usd;

      let chatId = input.resumeChatId;
      let killReason: KillReason | null = null;
      let finishedByResult = false;
      let buffer = '';
      const tail = new OutputTail();
      const stop = (reason: KillReason): void => {
        killReason = reason;
        sessionWrites.queue({
          chatId,
          resumed,
          completed: false,
          killReason,
          usd: sessionUsd(),
          resultName: input.resultName,
        });
        process.kill();
      };
      const guard = new LimitGuard(
        this.logger,
        {
          model: input.model,
          timeLimitMs: input.timeLimitMs ?? env.REQUIREMENTS_TIMEOUT_MS,
          idleLimitMs: env.IDLE_TIMEOUT_MS,
          spentUsd: input.spentUsd,
          maxRunUsd: env.MAX_RUN_USD,
          stepUsdMax: env.STEP_USD_MAX,
          tokensInRun: input.tokensInRun,
          maxRunTokens: env.MAX_RUN_TOKENS,
          stepTokenMax: env.STEP_TOKEN_MAX,
          auto: input.auto === true,
        },
        {
          awake,
          billed: () => meter.billed(),
          finished: () => finishedByResult,
          killReason: () => killReason,
          kill: stop,
        },
      );

      const onData = (chunk: Buffer): void => {
        awake.touch();
        log.note(chunk.toString('utf8'));
        input.onOutput?.(chunk.toString('utf8'));
        buffer += chunk.toString('utf8');
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          tail.stdout(line);
          const piece = meter.ingest(line);
          if (!piece) {
            continue;
          }
          if (piece.chatId) {
            chatId = piece.chatId;
            sessionWrites.queue({
              chatId,
              resumed,
              completed: false,
              killReason: null,
              usd: sessionUsd(),
              resultName: input.resultName,
            });
          }
          meter.count(piece);
          if (piece.stops && !finishedByResult) {
            finishedByResult = true;
            process.kill(false);
          }
        }
        if (killReason === null && !finishedByResult && input.loop?.pending()) {
          stop('loop');
        }
        guard.check();
      };
      const onErr = (chunk: Buffer): void => {
        awake.touch();
        log.note(chunk.toString('utf8'));
        tail.error(chunk.toString('utf8'));
      };
      const takeSample = containerSampler(this.sandbox, this.clock, process.containerName, 'agent', (sample) => {
        log.addSample(sample);
        log.publish();
      });
      const exitCode = await process.wait(
        {
          data: onData,
          error: onErr,
          processError: (error) => log.note(`${error.code ?? 'error'}: ${error.message}\n`),
          sample: takeSample,
          tick: () => guard.check(),
        },
        () => killReason !== null || finishedByResult,
        {
          time: awake,
          idleLimitMs: env.IDLE_TIMEOUT_MS,
          wallLimitMs: input.timeLimitMs ?? env.REQUIREMENTS_TIMEOUT_MS,
          timeout: () => guard.check(),
        },
      );
      await log.close();
      input.onLaunchEnd?.();
      const finished = this.clock.now();
      const priced = meter.billed();
      const finalKillReason = finishedByResult ? null : killReason;
      await sessionWrites.write({
        chatId,
        resumed,
        completed: finishedByResult || (killReason === null && exitCode === 0),
        killReason: finalKillReason,
        usd: sessionUsd(),
        resultName: input.resultName,
      });
      meter.flush(buffer);
      const end = tail.ending(runtime, buffer, this.clock.now());
      const ending =
        finishedByResult || !killReason
          ? `process exited ${finishedByResult ? 0 : exitCode}`
          : `process killed: ${String(killReason)}`;
      const output = log.finish(ending);
      await log.close();
      return {
        responseText: meter.answer(),
        chatId,
        tokensIn: priced.tokensIn,
        tokensOut: priced.tokensOut,
        usd: priced.usd,
        reported: meter.reported(),
        killReason: finalKillReason,
        exitCode: finishedByResult ? 0 : killReason ? 1 : exitCode,
        output,
        resumed,
        decided: meter.decided(input.answered),
        backgroundKilled: meter.backgroundKilled(input.answered),
        orphanOnly: meter.orphanOnly(),
        ...end,
        calls: 1,
        samples: log.samples,
        durationMs: finished - started,
        startedAt: new Date(started).toISOString(),
        finishedAt: new Date(finished).toISOString(),
      };
    } finally {
      await process.end();
      await log.close();
      await sessionWrites.settled();
    }
  }
}
