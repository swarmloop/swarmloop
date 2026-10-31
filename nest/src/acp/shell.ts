import { spawn, execFile } from 'child_process';
import { createInterface } from 'readline';
import { existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { isAbsolute, join, resolve } from 'path';
import { runtimeFor } from '../integrations/agent-runtime/agent-runtime.registry';
import {
  agentStateDir,
  containerName,
  hostName,
  imageName,
  isLocalHost,
  modelApiHosts,
  modelCredential,
  prepareStateDir,
  sandboxArgs,
  sandboxNetworkName,
  sandboxUserId,
  SandboxMount,
} from '../sandbox/sandbox-launch';
import { collectEnvMasks } from '../sandbox/sandbox.service';
import { HttpNestApi, NestApi, ShellFeature, ShellMatch } from './nest-api';
import { hostCheckout, nestCheckout } from './paths';
import { parseShell, pickSnapshot, ShellCommand } from './shell-command';
import { readShellConfig, ShellConfig } from './shell-env';

export async function runShell(argv: string[], cwd = process.cwd()): Promise<void> {
  const root = resolve(__dirname, '../../..');
  const api = new HttpNestApi(process.env.SWARMLOOP_API_URL ?? 'http://127.0.0.1:3920');
  try {
    await dispatch(argv, cwd, root, api);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'sloop failed'}\n`);
    process.exitCode = 1;
  }
}

async function dispatch(argv: string[], cwd: string, root: string, api: NestApi): Promise<void> {
  const listed = await api.list();
  const command = parseShell(argv, listed.runs.map((run) => run.key));
  const config = readShellConfig(join(root, '.env'));
  if (command.type === 'review') {
    await review(api, command, cwd, root, config.checkoutsRoot);
    return;
  }
  const feature = await resolveFeature(api, command.key, cwd, root, config.checkoutsRoot);
  if (command.type === 'step') {
    if (!command.step) {
      throw new Error('step is missing');
    }
    const started = await api.step(feature.key, command.step, { prompt: command.prompt || undefined });
    process.stderr.write(`${started.key} ${command.step} started\n`);
    return;
  }
  if (command.type === 'replay') {
    if (!command.prompt.trim()) {
      throw new Error('prompt is missing');
    }
    const started = await api.replay(feature.key, 'requirements', { prompt: command.prompt });
    process.stderr.write(`${started.key} replay started\n`);
    return;
  }
  if (command.type === 'rewind') {
    await rewind(api, feature.key, command.to);
    return;
  }
  if (feature.status === 'running') {
    throw new Error(`${feature.key} is already running`);
  }
  await attach(api, feature, command.vendor, config, root);
}

async function resolveFeature(
  api: NestApi,
  key: string | null,
  cwd: string,
  root: string,
  checkoutsRoot: string | undefined,
): Promise<ShellFeature> {
  if (key) {
    return api.shellFeature(key);
  }
  const opened = await api.shellOpen({ path: nestCheckout(cwd, root, checkoutsRoot) });
  if ('matches' in opened) {
    throw new Error(opened.matches.map((match) => matchLine(match)).join('\n') || 'several features match');
  }
  return opened;
}

function matchLine(match: ShellMatch): string {
  return `${match.key} ${match.status} ${match.currentStep}`;
}

async function review(
  api: NestApi,
  command: Extract<ShellCommand, { type: 'review' }>,
  cwd: string,
  root: string,
  checkoutsRoot: string | undefined,
): Promise<void> {
  const chosen = command.path ? (isAbsolute(command.path) ? command.path : resolve(cwd, command.path)) : cwd;
  const created = await api.create({
    path: nestCheckout(chosen, root, checkoutsRoot),
    prompt: command.prompt.trim() || 'Review this checkout.',
  });
  process.stderr.write(`${created.key} code review started\n`);
}

async function rewind(api: NestApi, key: string, to: string | null): Promise<void> {
  const listed = await api.snapshots(key);
  const id = to ? Number(to) : await chooseSnapshot(listed.snapshots);
  if (!Number.isInteger(id)) {
    throw new Error('snapshot is missing');
  }
  const restored = await api.rewind(key, id);
  process.stderr.write(`${key} rewound to ${restored.step}\n`);
}

async function chooseSnapshot(rows: { id: number; step: string; at: string }[]): Promise<number> {
  if (rows.length === 0) {
    throw new Error('snapshot is missing');
  }
  if (!process.stdin.isTTY) {
    throw new Error('--to is required');
  }
  for (const row of rows) {
    process.stderr.write(`${row.id} ${row.step} ${row.at}\n`);
  }
  const picked = pickSnapshot(rows, await ask('snapshot id: '));
  if (picked === null) {
    throw new Error('snapshot is missing');
  }
  return picked;
}

function ask(question: string): Promise<string> {
  const prompts = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolveAnswer) => {
    prompts.question(question, (answer) => {
      prompts.close();
      resolveAnswer(answer.trim());
    });
  });
}

async function attach(api: NestApi, feature: ShellFeature, vendor: string[], config: ShellConfig, root: string): Promise<void> {
  const runtime = runtimeFor(feature.runtime);
  if (!config.model) {
    throw new Error('MODEL_IMPLEMENT is missing');
  }
  const mounts = hostMounts(feature, root, config.checkoutsRoot);
  const workspace = mounts[0]?.containerPath ?? '/work';
  const interactive = vendor.length === 0 && process.stdout.isTTY === true;
  const userId = sandboxUserId();
  const statePath = agentStateDir(root, feature.key);
  prepareStateDir(statePath, userId);
  const maskFile = join(tmpdir(), 'swarmloop-empty-env');
  if (!existsSync(maskFile)) {
    writeFileSync(maskFile, '');
  }
  const args = sandboxArgs({
    runtime: runtime.name,
    runKey: feature.key,
    step: 'shell',
    mounts,
    envMasks: collectEnvMasks(mounts),
    allowHosts: modelApiHosts(runtime.name),
    command: [
      runtime.command,
      ...runtime.terminalArgs({
        model: config.model,
        workspace,
        resumeChatId: feature.resumeChatId,
        vendor,
      }),
    ],
    userId,
    maskFile,
    env: [modelCredential(runtime.name, config.cursorKey, config.anthropicKey, config.oauthToken)],
    statePath,
    stateDaemonPath: statePath,
    stdin: interactive,
    tty: interactive,
  });
  await docker(['image', 'inspect', imageName(runtime.name)]);
  const name = containerName(feature.key, 'shell');
  await api.shellLock(feature.key, name);
  let code = 1;
  try {
    await ensureNetwork(modelApiHosts(runtime.name));
    code = await runDocker(args);
  } finally {
    if ((await containerRunning(name)) !== true) {
      await api.shellUnlock(feature.key);
    }
  }
  process.exitCode = code;
}

function hostMounts(feature: ShellFeature, root: string, checkoutsRoot: string | undefined): SandboxMount[] {
  return feature.mounts.map((mount) => ({
    hostPath: hostCheckout(mount.hostPath, root, checkoutsRoot),
    containerPath: mount.containerPath,
  }));
}

async function ensureNetwork(allowHosts: string[]): Promise<void> {
  const network = sandboxNetworkName(allowHosts);
  if (!network) {
    return;
  }
  try {
    await docker(['network', 'inspect', network]);
  } catch {
    const args = ['network', 'create'];
    if (allowHosts.every((entry) => isLocalHost(hostName(entry)))) {
      args.push('--internal');
    }
    args.push(network);
    await docker(args);
  }
}

function containerRunning(name: string): Promise<boolean | null> {
  return new Promise((resolveRunning) => {
    execFile('docker', ['inspect', '--format', '{{.State.Running}}', name], { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        const text = `${stderr ?? ''} ${error.message}`;
        resolveRunning(text.includes('No such object') || text.includes('No such container') ? false : null);
        return;
      }
      resolveRunning(stdout.trim() === 'true');
    });
  });
}

function docker(args: string[]): Promise<void> {
  return new Promise((resolveDone, reject) => {
    execFile('docker', args, { encoding: 'utf8' }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || error.message).trim()));
        return;
      }
      resolveDone();
    });
  });
}

function runDocker(args: string[]): Promise<number> {
  return new Promise((resolveCode) => {
    const child = spawn('docker', args, { stdio: 'inherit' });
    child.on('error', () => {
      process.stderr.write('docker is not running\n');
      resolveCode(1);
    });
    child.on('exit', (status) => resolveCode(status ?? 1));
  });
}
