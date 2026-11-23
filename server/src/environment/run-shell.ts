import { createHash } from 'crypto';
import { createWriteStream, mkdirSync, writeFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import { SAMPLE_MS } from '../core/awake-time';
import type { Clock } from '../core/clock';
import { markedInterval } from '../core/entered-marks';
import { runFileName } from '../core/run-files';
import { markedTail, runLogPath } from '../core/run-logs';
import type { SandboxMount } from '../core/sandbox-mount';
import { startCommandSpan } from '../core/step-event-scope';
import type { LiveSample } from '../contract/live';
import { SERVER_PAUSE_NOTE } from '../contract/server-pause';
import type { SampleDraft } from '../history/visit';
import type { LiveHub } from '../live/live.hub';
import { containerSampler } from '../sandbox/container-sampler';
import type { ManifestHosts, ProjectLaunch } from '../sandbox/sandbox-launch';
import { prepareRunTmp, runTmpDir } from '../sandbox/run-tmp';
import { agentStateDir, sandboxUserId } from '../sandbox/sandbox-launch';
import type { SandboxService } from '../sandbox/sandbox.service';
import type { CpuSlice } from '../sandbox/sandbox-types';
import { startShell, type ShellInput } from './shell-launch';

const SETUP_TIMEOUT_MS = 30 * 60_000;
const TAIL_LINES = 80;
/** The lines the live view shows of a running command. */
const LIVE_LINES = 200;
const TAIL_CHARS = 6000;

export interface ShellDeps {
  root: string;
  clock: Clock;
  sandbox: Pick<SandboxService, 'spawn' | 'kill' | 'stats'>;
  live?: Pick<LiveHub, 'log'>;
  /** True for a run the user stopped: its containers die by docker stop and kill, not by their memory cap. */
  halted?: (key: string) => boolean;
}

/**
 * The setup and each check command run in the project image with no model key. The output goes to the step log; every
 * command also streams its full output to its own file in the run's log folder, and the returned tail marks the lines
 * it leaves out. Its container is sampled like the agent's.
 */
export async function runShell(
  deps: ShellDeps,
  input: ShellInput,
  launch: ProjectLaunch,
  command: string,
  mount: SandboxMount,
  phase: 'setup' | 'checks',
  check?: { index: number; file: string; name?: string },
  /** The manifest hosts of the setup. Checks get none. */
  manifest?: ManifestHosts,
  /** The number of the check place the command runs in. */
  place?: number,
  /** The allocation used at admission, including an explicit unknown-core fallback. */
  cpuSlice?: CpuSlice | null,
): Promise<{ exitCode: number; tail: string; outOfMemoryBytes?: number }> {
  const { root, clock, sandbox, live } = deps;
  const userId = sandboxUserId();
  const unit = check ? `${basename(mount.hostPath)}-${check.index}` : basename(mount.hostPath);
  const statePath = agentStateDir(root, input.key, `${phase}-${unit}`);
  // Setup and checks never see what an earlier command left in /tmp, so a verdict does not depend on it.
  const tmp = await prepareRunTmp(runTmpDir(root, input.key, `${phase}-${unit}`), userId, true);
  // Every command streams to its file, so memory keeps only the window the live view and the tail read.
  const keep = check ? LIVE_LINES : 2000;
  const lines: string[] = [`$ ${command}`];
  let total = 1;
  const digest = createHash('sha1').update(command).digest('hex').slice(0, 8);
  const logFile =
    check?.file ??
    runLogPath(root, input.key, `${input.step}-${input.run.activeAttempt ?? ''}-${phase}-${unit}-${digest}`);
  if (check) {
    mkdirSync(dirname(check.file), { recursive: true });
  }
  const file = createWriteStream(logFile, { flags: 'w' });
  file.write(`${lines[0]}\n`);
  const add = (...added: string[]) => {
    lines.push(...added);
    total += added.length;
    file.write(added.map((line) => `${line}\n`).join(''));
    if (lines.length > keep) {
      lines.splice(1, lines.length - keep);
    }
  };
  let shown = 0;
  const show = (force = false) => {
    const now = clock.now();
    if (force || now - shown >= 1000) {
      shown = now;
      live?.log({
        key: input.key,
        step: input.step,
        body: `${lines.slice(-LIVE_LINES).join('\n')}\n`,
        ...(check ? { command: check.index, samples: liveSamples(input.samples ?? []) } : {}),
      });
    }
  };
  show(true);
  const outputFile = join(root, 'data', runFileName(input.key, phase, 'output'));
  const finish = startCommandSpan({
    actor: 'server',
    repo: basename(mount.hostPath),
    cwd: mount.hostPath,
    executable: 'sh',
    args: [command],
  });
  let timedOut = false;
  const onPaused = () => {
    live?.log({
      key: input.key,
      step: input.step,
      body: `${SERVER_PAUSE_NOTE}\n`,
      ...(check ? { command: check.index, samples: liveSamples(input.samples ?? []) } : {}),
    });
  };
  const child = await startShell(
    sandbox,
    { input, launch, command, mount, phase, check, place, cpuSlice, manifest, statePath, userId, tmp },
    onPaused,
    async () => {
      finish({ exitCode: null });
      await new Promise<void>((done) => file.end(done));
    },
  );
  const take = containerSampler(
    sandbox,
    clock,
    child.containerName,
    check ? String(check.index) : 'setup',
    (sample) => {
      input.samples?.push(sample);
      if (check) {
        show(true);
      }
    },
  );
  take();
  const sampler = markedInterval('check sample', take, SAMPLE_MS);
  let partial = '';
  const read = (chunk: Buffer) => {
    const text = partial + chunk.toString('utf8');
    const parts = text.split(/\r?\n/);
    partial = parts.pop() ?? '';
    add(...parts);
    show();
  };
  child.stdout?.on('data', read);
  child.stderr?.on('data', read);
  const exitCode = await new Promise<number>((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      add(`${phase} timed out after ${SETUP_TIMEOUT_MS / 60_000} min`);
      void sandbox.kill(child.containerName).then(
        () => resolve(124),
        () => resolve(124),
      );
    }, SETUP_TIMEOUT_MS);
    child.once('error', (error: Error) => {
      clearTimeout(timer);
      add(`docker could not start: ${error.message}`);
      resolve(1);
    });
    child.once('close', (code: number | null) => {
      clearTimeout(timer);
      resolve(timedOut ? 124 : (code ?? 1));
    });
  });
  clearInterval(sampler);
  if (partial) {
    add(partial);
  }
  add(`exit ${exitCode}`);
  show(true);
  finish({ exitCode, timedOut, output: lines.join('\n'), outputLines: total });
  await new Promise<void>((done) => file.end(done));
  if (!check) {
    mkdirSync(dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, `${lines.join('\n')}\n`);
  }
  const tail = markedTail(lines, total, TAIL_LINES, TAIL_CHARS, logFile);
  // 137 is a kill by the container's memory cap unless swarmloop killed it: the timeout or a Stop.
  return exitCode === 137 && !timedOut && !deps.halted?.(input.key) && child.memoryCapBytes !== undefined
    ? { exitCode, tail, outOfMemoryBytes: child.memoryCapBytes }
    : { exitCode, tail };
}

export function liveSamples(samples: readonly SampleDraft[]): LiveSample[] {
  return samples.map((sample) => ({
    at: sample.sampledAt,
    cpu: sample.cpuPercent,
    memory: sample.rssBytes,
    source: sample.source,
  }));
}
