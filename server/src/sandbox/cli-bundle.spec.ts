import { SwarmloopError } from '../core/swarmloop-error';
import { CliBundles, cliVolumeName } from './cli-bundle';

const ID = 'sha256:0123456789abcdef0123456789abcdef';

function fakeDocker(state: { complete: boolean; volumes: string[]; missing?: boolean; inUse?: string[] }) {
  return jest.fn((args: string[]) => {
    const [first, second] = args;
    if (first === 'image') {
      return state.missing ? Promise.reject(new Error('no such image')) : Promise.resolve(`${ID}\n`);
    }
    if (first === 'volume' && second === 'ls') {
      return Promise.resolve(`${state.volumes.join('\n')}\n`);
    }
    if (first === 'volume' && second === 'rm') {
      return (state.inUse ?? []).includes(args[2] ?? '') ? Promise.reject(new Error('in use')) : Promise.resolve('');
    }
    if (first === 'run') {
      const script = args.at(-1) ?? '';
      if (script.startsWith('test -f')) {
        return Promise.resolve(state.complete ? 'yes\n' : 'no\n');
      }
      state.complete = true;
      return Promise.resolve('');
    }
    return Promise.resolve('');
  });
}

describe('cliVolumeName', () => {
  it('names the volume after the runtime and the image id', () => {
    expect(cliVolumeName('claude', ID)).toBe('swarmloop-cli-claude-0123456789ab');
  });

  it('refuses a strange runtime or id', () => {
    expect(() => cliVolumeName('cla ude', ID)).toThrow(SwarmloopError);
    expect(() => cliVolumeName('claude', 'sha256:xyz')).toThrow(SwarmloopError);
  });
});

describe('CliBundles', () => {
  it('copies the CLI once and reuses the volume', async () => {
    const state = { complete: false, volumes: [] as string[] };
    const docker = fakeDocker(state);
    const bundles = new CliBundles(docker);
    const [first, second] = await Promise.all([
      bundles.ensure('codex', 'swarmloop-agent-codex'),
      bundles.ensure('codex', 'swarmloop-agent-codex'),
    ]);
    expect(first).toBe('swarmloop-cli-codex-0123456789ab');
    expect(second).toBe(first);
    const copies = docker.mock.calls.filter((call) => (call[0].at(-1) ?? '').includes('cp -a'));
    expect(copies).toHaveLength(1);
    const copy = copies[0]?.[0] ?? [];
    expect(copy).toEqual(expect.arrayContaining(['--network', 'none', '--rm']));
    expect(copy.join(' ')).toContain('type=volume,src=swarmloop-cli-codex-0123456789ab,dst=/out');
  });

  it('does not copy again into a complete volume', async () => {
    const docker = fakeDocker({ complete: true, volumes: [] });
    await new CliBundles(docker).ensure('claude', 'swarmloop-agent-claude');
    expect(docker.mock.calls.some((call) => (call[0].at(-1) ?? '').includes('cp -a'))).toBe(false);
  });

  it('removes older volumes of the same runtime and keeps one that is in use', async () => {
    const state = {
      complete: true,
      volumes: [
        'swarmloop-cli-claude-0123456789ab',
        'swarmloop-cli-claude-aaaaaaaaaaaa',
        'swarmloop-cli-claude-bbbbbbbbbbbb',
      ],
      inUse: ['swarmloop-cli-claude-bbbbbbbbbbbb'],
    };
    const docker = fakeDocker(state);
    await new CliBundles(docker).ensure('claude', 'swarmloop-agent-claude');
    const removed = docker.mock.calls.filter((call) => call[0][1] === 'rm').map((call) => call[0][2]);
    expect(removed).toEqual(['swarmloop-cli-claude-aaaaaaaaaaaa', 'swarmloop-cli-claude-bbbbbbbbbbbb']);
  });

  it('says how to build a missing agent image and tries again next time', async () => {
    const state = { complete: false, volumes: [] as string[], missing: true };
    const docker = fakeDocker(state);
    const bundles = new CliBundles(docker);
    await expect(bundles.ensure('cursor', 'swarmloop-agent-cursor')).rejects.toThrow('run docker/sandbox/build.sh');
    state.missing = false;
    await expect(bundles.ensure('cursor', 'swarmloop-agent-cursor')).resolves.toBe('swarmloop-cli-cursor-0123456789ab');
  });
});
