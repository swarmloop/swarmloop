import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { SandboxLaunch } from '../sandbox/sandbox-launch';

/**
 * A docker that knows every image and runs a container that ends at once with the exit code `exitCodeOf` gives for
 * its launch. It notes every container it was asked for.
 */
export function checkDocker(exitCodeOf: (launch: SandboxLaunch) => number) {
  const spawned: SandboxLaunch[] = [];
  return {
    spawned,
    calls: {
      run: (args: string[]) => {
        const last = args.at(-1) ?? '';
        if (args[0] === 'image' && args.includes('{{.Id}}'))
          return Promise.resolve(`sha256:${createHash('sha256').update(last).digest('hex')}\n`);
        if (args[0] === 'image' && args.includes('{{json .Config.Env}}'))
          return Promise.resolve('["PATH=/usr/bin:/bin"]');
        if (args[0] === 'run' && args.includes('-c') && last.includes('certs='))
          return Promise.resolve('certs=no\nv1\n');
        if (args[0] === 'run' && last.startsWith('test -f')) return Promise.resolve('yes\n');
        return Promise.resolve('');
      },
      spawn: (launch: SandboxLaunch) => {
        spawned.push(launch);
        const child = Object.assign(new EventEmitter(), {
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          containerName: 'swarmloop-check-docker',
        });
        setImmediate(() => child.emit('close', exitCodeOf(launch)));
        return Promise.resolve(child);
      },
      stats: () => Promise.resolve({ cpuPercent: 1, rssBytes: 1024 }),
      stateDaemonPath: (path: string) => Promise.resolve(path),
    },
  };
}
