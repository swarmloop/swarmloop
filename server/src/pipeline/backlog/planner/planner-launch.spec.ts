import { EventEmitter } from 'events';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { PassThrough } from 'stream';
import { root } from '../../../history/run-paths';
import { AgentProcessRunner } from '../../../agent/agent-runner';
import { RunStop } from '../../../agent/run-stop';
import { modelApiHosts } from '../../../sandbox/sandbox-launch';
import type { SandboxLaunch } from '../../../sandbox/sandbox-launch';
import { resultAnswer } from '../../../testing/result-answer';
import { plannerTurnsHarness } from './planner-turns.spec-helpers';

/** A container that answers with an empty turn and ends. */
function answeringChild() {
  const child = new EventEmitter();
  const stdout = new PassThrough();
  setImmediate(() => {
    const answer = resultAnswer('Done.', { say: '', actions: [] });
    stdout.write(`${JSON.stringify({ type: 'result', result: answer })}\n`);
    child.emit('close', 0);
  });
  return Object.assign(child, { stdout, stderr: new PassThrough(), containerName: 'box', kill: () => true });
}

describe('the launch of a planner turn', () => {
  it('mounts every work folder read only, reaches only the model hosts, carries only the model credential and mounts no docker socket', async () => {
    const launches: SandboxLaunch[] = [];
    const sandbox = {
      assertReady: async () => undefined,
      kill: async () => undefined,
      stats: async () => ({ cpuPercent: 0, rssBytes: 0 }),
      spawn: async (launch: SandboxLaunch) => {
        launches.push(launch);
        return answeringChild();
      },
    };
    const h = await plannerTurnsHarness(
      {
        AGENTS_BACKLOG_PLAN: 'cursor:m',
        CURSOR_API_KEY: 'model-key',
        SWARMLOOP_TOKEN: 'person-token',
        GITLAB_TOKEN: 'host-token',
      },
      (config, clock) => {
        const price = { inputPerMillion: 1, outputPerMillion: 1, cacheReadPerMillion: 0, cacheWritePerMillion: 0 };
        mkdirSync(join(root(config), 'data'), { recursive: true });
        writeFileSync(
          join(root(config), 'data', 'price-cache-cursor.json'),
          JSON.stringify({ fetchedAt: new Date(clock.now()).toISOString(), prices: { m: price } }),
        );
        return new AgentProcessRunner(config, clock, sandbox as never, new RunStop());
      },
    );
    try {
      h.setMain('web');
      const id = (await h.seedBacklog('one')).id as number;
      await h.chat.addPersonMessage(id, 'plan it', 'm1', []);
      await h.openTurn(id, 'turn-a');
      expect(await h.runner.run('one', 'turn-a')).toEqual({ status: 'done' });

      expect(launches).toHaveLength(1);
      const [launch] = launches;
      const work = launch.mounts.filter((mount) => mount.containerPath.startsWith('/work/'));
      expect(work.length).toBeGreaterThan(0);
      expect(work.every((mount) => mount.readonly === true)).toBe(true);
      expect(launch.allowHosts).toEqual(modelApiHosts('cursor'));
      expect(launch.manifestHosts).toBeUndefined();
      expect(launch.project).toBeUndefined();
      expect(launch.env).toEqual([{ name: 'CURSOR_API_KEY', value: 'model-key' }]);
      const paths = launch.mounts.flatMap((mount) => [mount.hostPath, mount.containerPath, mount.daemonPath ?? '']);
      expect(paths.some((path) => path.includes('docker.sock'))).toBe(false);
    } finally {
      await h.close();
    }
  });
});
