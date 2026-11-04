import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const source = new URL('../docker/sandbox/swarmloop-verify', import.meta.url);

async function helper(configured) {
  const root = await mkdtemp(join(tmpdir(), 'swarmloop-verify-script-'));
  const script = join(root, 'swarmloop-verify');
  const text = await readFile(source, 'utf8');
  await writeFile(script, text.replace('root=/home/sandbox/.swarmloop', `root=${root}/.swarmloop`), { mode: 0o755 });
  if (configured) {
    await mkdir(join(root, '.swarmloop'), { recursive: true });
    await writeFile(join(root, '.swarmloop', 'verify.enabled'), '');
  }
  return { root, script };
}

function run(script, env = {}) {
  return new Promise((resolve) => {
    execFile(script, [], { env: { ...process.env, ...env } }, (error, stdout) => {
      resolve({ code: error?.code ?? 0, stdout });
    });
  });
}

test('swarmloop-verify prints the server answer and uses its exit code', async () => {
  const { root, script } = await helper(true);
  const responder = (async () => {
    const directory = join(root, '.swarmloop', 'verify');
    for (;;) {
      try {
        const request = join(directory, (await readdir(directory)).find((file) => file.endsWith('.req')) ?? '');
        await readFile(request);
        const temp = request.replace('.req', '.tmp');
        await writeFile(temp, 'exit: 1\nfailed\n');
        await rename(temp, request.replace('.req', '.res'));
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  })();
  const result = await run(script);
  await responder;
  assert.equal(result.code, 1);
  assert.equal(result.stdout, 'exit: 1\nfailed\n');
  await rm(root, { recursive: true, force: true });
});

test('swarmloop-verify returns at once when no bridge is configured', async () => {
  const { root, script } = await helper(false);
  const result = await run(script);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'verify is not configured for this project\n');
  await rm(root, { recursive: true, force: true });
});

test('swarmloop-verify reports no answer', async () => {
  const { root, script } = await helper(true);
  const result = await run(script, { SWARMLOOP_VERIFY_WAIT_S: '0' });
  assert.equal(result.code, 3);
  assert.equal(result.stdout, 'swarmloop-verify: no answer\n');
  await rm(root, { recursive: true, force: true });
});
