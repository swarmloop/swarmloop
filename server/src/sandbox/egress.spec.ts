import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SwarmloopError } from '../core/swarmloop-error';
import { EGRESS_IP, EGRESS_NETWORK, EGRESS_SUBNET, Egress, egressEnv, egressMode, isLeaseIp } from './egress';

interface State {
  network?: { internal: boolean; subnet: string };
  image?: string;
  proxy?: { running: boolean; image: string; user: string; ip: string; bridge: boolean };
}

function fakeDocker(state: State) {
  const calls: string[][] = [];
  const docker = jest.fn((args: string[]) => {
    calls.push(args);
    const [first, second] = args;
    if (first === 'network' && second === 'inspect') {
      return state.network
        ? Promise.resolve(
            `${JSON.stringify(state.network.internal)} ${JSON.stringify([{ Subnet: state.network.subnet }])}\n`,
          )
        : Promise.reject(new Error('No such network'));
    }
    if (first === 'network' && second === 'create') {
      state.network = { internal: args.includes('--internal'), subnet: args[args.indexOf('--subnet') + 1] ?? '' };
      return Promise.resolve('');
    }
    if (first === 'image') {
      return state.image ? Promise.resolve(`${state.image}\n`) : Promise.reject(new Error('No such image'));
    }
    if (first === 'inspect') {
      if (!state.proxy) {
        return Promise.reject(new Error('No such container'));
      }
      const networks: Record<string, { IPAddress: string }> = { [EGRESS_NETWORK]: { IPAddress: state.proxy.ip } };
      if (state.proxy.bridge) {
        networks.bridge = { IPAddress: '172.17.0.5' };
      }
      return Promise.resolve(
        `${JSON.stringify(state.proxy.running)} ${JSON.stringify({ 'swarmloop.image': state.proxy.image, 'swarmloop.user': state.proxy.user })} ${JSON.stringify(networks)}\n`,
      );
    }
    if (first === 'logs') {
      return Promise.resolve(
        state.proxy?.running ? '{"event":"listening","port":3128}\n{"event":"listening","port":3129}\n' : '',
      );
    }
    if (first === 'rm') {
      delete state.proxy;
      return Promise.resolve('');
    }
    if (first === 'run') {
      state.proxy = {
        running: true,
        image: state.image ?? '',
        user: (args[args.indexOf('--user') + 1] ?? '').split(':')[0] ?? '',
        ip: args[args.indexOf('--ip') + 1] ?? '',
        bridge: false,
      };
      return Promise.resolve('id\n');
    }
    if (first === 'network' && second === 'connect' && state.proxy) {
      state.proxy.bridge = true;
    }
    return Promise.resolve('');
  });
  return { docker, calls };
}

function setup(
  state: State,
  now = 1_000,
  users: { uid: number; own: number; adopt?: boolean; startMs?: number } = { uid: 501, own: 501 },
) {
  const policyDir = join(mkdtempSync(join(tmpdir(), 'swarmloop-egress-')), 'egress');
  const fake = fakeDocker(state);
  let clock = now;
  const egress = new Egress({
    docker: fake.docker,
    policyDir,
    daemonPath: (dir) => Promise.resolve(`/host${dir}`),
    now: () => clock,
    ...users,
  });
  return { egress, policyDir, ...fake, tick: (ms: number) => (clock += ms) };
}

describe('Egress', () => {
  it('creates the internal network and starts a hardened proxy on its fixed address', async () => {
    const { egress, calls, policyDir } = setup({ image: 'sha256:abc' });
    await egress.ensure();
    expect(calls).toContainEqual(['network', 'create', '--internal', '--subnet', EGRESS_SUBNET, EGRESS_NETWORK]);
    const run = calls.find((call) => call[0] === 'run') ?? [];
    expect(run).toEqual(
      expect.arrayContaining([
        '--read-only',
        '--cap-drop',
        'ALL',
        'no-new-privileges',
        '--user',
        '501:501',
        '--ip',
        EGRESS_IP,
      ]),
    );
    expect(run.join(' ')).toContain(`type=bind,src=/host${policyDir},dst=/policies,readonly=true`);
    expect(run.join(' ')).toContain('swarmloop.image=sha256:abc');
    expect(calls).toContainEqual(['network', 'connect', 'bridge', 'swarmloop-egress']);
  });

  it('leaves a running proxy of the current image alone', async () => {
    const { egress, calls } = setup({
      network: { internal: true, subnet: EGRESS_SUBNET },
      image: 'sha256:abc',
      proxy: { running: true, image: 'sha256:abc', user: '501', ip: EGRESS_IP, bridge: true },
    });
    await egress.ensure();
    expect(calls.some((call) => call[0] === 'run' || call[0] === 'rm')).toBe(false);
  });

  it('runs the proxy unprivileged when a root server hands it the policies', async () => {
    const me = process.getuid?.() ?? 0;
    const { egress, calls, policyDir } = setup({ image: 'sha256:abc' }, 1_000, { uid: me, own: 0 });
    const lease = await egress.lease({ hosts: ['api.openai.com'] });
    const run = calls.find((call) => call[0] === 'run') ?? [];
    expect(run[run.indexOf('--user') + 1]).toBe(`${me}:${me}`);
    expect(run).toContain(`swarmloop.user=${me}`);
    expect(statSync(join(policyDir, `${lease.ip}.json`)).uid).toBe(me);
  });

  (process.getuid?.() === 0 ? it.skip : it)(
    'keeps the proxy as root when the policies cannot be handed over',
    async () => {
      const { egress, calls } = setup({ image: 'sha256:abc' }, 1_000, { uid: 4242, own: 0 });
      await egress.lease({ hosts: ['api.openai.com'] });
      const run = calls.find((call) => call[0] === 'run') ?? [];
      expect(run[run.indexOf('--user') + 1]).toBe('0:0');
    },
  );

  it('starts the proxy again after a rebuild of its image or when it lost its way out', async () => {
    for (const proxy of [
      { running: true, image: 'sha256:old', user: '501', ip: EGRESS_IP, bridge: true },
      { running: true, image: 'sha256:abc', user: '501', ip: EGRESS_IP, bridge: false },
      { running: false, image: 'sha256:abc', user: '501', ip: EGRESS_IP, bridge: true },
      { running: true, image: 'sha256:abc', user: '0', ip: EGRESS_IP, bridge: true },
    ]) {
      const { egress, calls } = setup({
        network: { internal: true, subnet: EGRESS_SUBNET },
        image: 'sha256:abc',
        proxy,
      });
      await egress.ensure();
      expect(calls.filter((call) => call[0] === 'run')).toHaveLength(1);
    }
  });

  it('refuses a network of that name that has a way out', async () => {
    const { egress } = setup({ network: { internal: false, subnet: EGRESS_SUBNET }, image: 'sha256:abc' });
    await expect(egress.ensure()).rejects.toThrow('is not internal');
  });

  it('waits until the new proxy listens, and says why when it never does', async () => {
    const state: State = { image: 'sha256:abc' };
    const { egress, docker } = setup(state, 1_000, { uid: 501, own: 501, startMs: 300 });
    const listen = docker.getMockImplementation();
    docker.mockImplementation((args: string[]) =>
      args[0] === 'logs'
        ? Promise.resolve('Error: EACCES: permission denied\n')
        : (listen?.(args) ?? Promise.resolve('')),
    );
    await expect(egress.ensure()).rejects.toThrow('does not listen: Error: EACCES');
  });

  it('borrows a running proxy that someone else started when told to', async () => {
    const proxy = { running: true, image: 'sha256:abc', user: '1000', ip: EGRESS_IP, bridge: true };
    const network = { internal: true, subnet: EGRESS_SUBNET };
    const own = setup({ network, image: 'sha256:abc', proxy: { ...proxy } });
    await own.egress.ensure();
    expect(own.calls.some((call) => call[0] === 'run')).toBe(true);
    const shell = setup({ network, image: 'sha256:abc', proxy: { ...proxy } }, 1_000, {
      uid: 501,
      own: 501,
      adopt: true,
    });
    await shell.egress.ensure();
    expect(shell.calls.some((call) => call[0] === 'run' || call[0] === 'rm')).toBe(false);
  });

  it('brings a removed proxy back for the next lease', async () => {
    const state: State = { image: 'sha256:abc' };
    const { egress, calls } = setup(state);
    await egress.lease({ hosts: ['api.openai.com'] });
    delete state.proxy;
    await egress.lease({ hosts: ['api.openai.com'] });
    expect(calls.filter((call) => call[0] === 'run')).toHaveLength(2);
  });

  it('says how to build a missing proxy image and tries again next time', async () => {
    const state: State = {};
    const { egress } = setup(state);
    await expect(egress.ensure()).rejects.toThrow(SwarmloopError);
    state.image = 'sha256:abc';
    await expect(egress.ensure()).resolves.toBeUndefined();
  });

  it('writes one private policy per address before the container starts, and removes it at the end', async () => {
    const { egress, policyDir } = setup({ image: 'sha256:abc' });
    const leases = await Promise.all(Array.from({ length: 20 }, () => egress.lease({ hosts: ['registry.npmjs.org'] })));
    expect(new Set(leases.map((lease) => lease.ip)).size).toBe(20);
    expect(leases.every((lease) => isLeaseIp(lease.ip))).toBe(true);
    const first = leases[0];
    const file = join(policyDir, `${first?.ip}.json`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ hosts: ['registry.npmjs.org'] });
    first?.release();
    expect(readdirSync(policyDir)).toHaveLength(19);
  });

  it('drops a policy that a crashed server left behind once it has expired', async () => {
    const { egress, policyDir, tick } = setup({ image: 'sha256:abc' });
    await egress.ensure();
    writeFileSync(join(policyDir, '198.18.9.9.json'), JSON.stringify({ hosts: [], expires: 500 }));
    tick(1);
    await egress.lease({ hosts: ['pypi.org'] });
    expect(readdirSync(policyDir)).not.toContain('198.18.9.9.json');
  });
});

describe('egress settings', () => {
  it('points every common tool at the proxy and keeps the proxy itself direct', () => {
    const env = Object.fromEntries(egressEnv().map((item) => [item.name, item.value]));
    expect(env.HTTPS_PROXY).toBe(`http://${EGRESS_IP}:3128`);
    expect(env.http_proxy).toBe(`http://${EGRESS_IP}:3128`);
    expect(env.NO_PROXY).toContain(EGRESS_IP);
    expect(env.JAVA_TOOL_OPTIONS).toContain(`-Dhttps.proxyHost=${EGRESS_IP}`);
  });

  it('is on unless it is turned off on purpose', () => {
    expect(egressMode(undefined)).toBe('proxy');
    expect(egressMode('proxy')).toBe('proxy');
    expect(egressMode('typo')).toBe('proxy');
    expect(egressMode('open')).toBe('open');
  });

  it('hands out sandbox addresses only, never the proxy or the gateway', () => {
    expect(isLeaseIp('198.18.5.7')).toBe(true);
    expect(isLeaseIp(EGRESS_IP)).toBe(false);
    expect(isLeaseIp('198.18.0.1')).toBe(false);
    expect(isLeaseIp('10.0.0.1')).toBe(false);
  });
});
