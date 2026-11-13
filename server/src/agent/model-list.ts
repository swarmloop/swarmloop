import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import type { SandboxMount } from '../core/sandbox-mount';
import type { AgentRuntime } from '../integrations/agent-runtime/agent-runtime';
import { modelApiHosts, sandboxUserId } from '../sandbox/sandbox-launch';
import type { SandboxService } from '../sandbox/sandbox.service';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The raw output of a runtime's model list, cached for a day in `data/model-list-<runtime>.json`. A read that fails
 * or prints nothing keeps the old cache. A runtime with no list gives an empty text. The vendor's format is parsed
 * in its own adapter, not here.
 */
export async function loadModelList(
  root: string,
  runtime: AgentRuntime,
  now: number,
  list: () => Promise<string>,
): Promise<string> {
  if (runtime.modelListArgs() === null) {
    return '';
  }
  const file = join(root, 'data', `model-list-${runtime.name}.json`);
  const cached = await readCache(file);
  if (cached && now - Date.parse(cached.fetchedAt) < DAY_MS) {
    return cached.output;
  }
  try {
    const output = await list();
    if (output.trim() === '') {
      return cached?.output ?? '';
    }
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify({ fetchedAt: new Date(now).toISOString(), output })}\n`);
    return output;
  } catch {
    return cached?.output ?? '';
  }
}

/** Runs the model list of a runtime in its own image through the sandbox, and returns what it prints. */
export function sandboxModelLister(
  sandbox: SandboxService,
  runtime: AgentRuntime,
  credential: { name: string; value: string },
  mount: SandboxMount,
): () => Promise<string> {
  return async () => {
    const child = await sandbox.spawn({
      runtime: runtime.name,
      runKey: 'model-list',
      step: `model-list-${runtime.name}`,
      attemptId: '',
      mounts: [mount],
      allowHosts: modelApiHosts(runtime.name),
      env: [credential],
      command: [runtime.command, ...(runtime.modelListArgs() ?? [])],
      userId: sandboxUserId(),
    });
    const chunks: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    if (code !== 0) {
      throw new Error(`model list exited with ${code}`);
    }
    return Buffer.concat(chunks).toString('utf8');
  };
}

async function readCache(file: string): Promise<{ fetchedAt: string; output: string } | null> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { fetchedAt?: unknown; output?: unknown };
    if (typeof parsed.fetchedAt !== 'string' || typeof parsed.output !== 'string') {
      return null;
    }
    return { fetchedAt: parsed.fetchedAt, output: parsed.output };
  } catch {
    return null;
  }
}
