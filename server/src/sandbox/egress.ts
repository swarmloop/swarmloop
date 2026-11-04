import { randomInt } from 'crypto';
import { chownSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { SwarmloopError } from '../core/swarmloop-error';

/** The internal network every sandbox lives on. It has no route out: the egress proxy is the only way. */
export const EGRESS_NETWORK = 'swarmloop-sandbox';
export const EGRESS_SUBNET = '198.18.0.0/16';
export const EGRESS_IP = '198.18.0.2';
export const EGRESS_IMAGE = 'swarmloop-egress';
export const EGRESS_CONTAINER = 'swarmloop-egress';
export const EGRESS_PROXY = `http://${EGRESS_IP}:3128`;
/** The model API on the proxy. A CLI pointed here sends a placeholder key; the proxy sends the real one. */
export const EGRESS_API = `http://${EGRESS_IP}:3129`;
/** Long enough for the longest step; a policy left by a crashed server expires on its own. */
const POLICY_TTL_MS = 26 * 60 * 60_000;

export type EgressMode = 'proxy' | 'open';

export interface ApiPolicy {
  upstream: string;
  header: string;
  value: string;
}

export interface EgressPolicy {
  hosts: string[];
  api?: ApiPolicy;
}

export interface EgressLease {
  ip: string;
  release: () => void;
}

export type Docker = (args: string[], timeoutMs?: number) => Promise<string>;

export function egressMode(value: string | undefined): EgressMode {
  return value === 'open' ? 'open' : 'proxy';
}

/** Proxy settings for every common tool. JVM builds read them from JAVA_TOOL_OPTIONS. */
export function egressEnv(): { name: string; value: string }[] {
  const noProxy = `localhost,127.0.0.1,::1,${EGRESS_IP}`;
  const jvm = [
    `-Dhttp.proxyHost=${EGRESS_IP}`,
    '-Dhttp.proxyPort=3128',
    `-Dhttps.proxyHost=${EGRESS_IP}`,
    '-Dhttps.proxyPort=3128',
    `-Dhttp.nonProxyHosts=localhost|127.0.0.1|${EGRESS_IP}`,
  ].join(' ');
  return [
    { name: 'HTTPS_PROXY', value: EGRESS_PROXY },
    { name: 'HTTP_PROXY', value: EGRESS_PROXY },
    { name: 'https_proxy', value: EGRESS_PROXY },
    { name: 'http_proxy', value: EGRESS_PROXY },
    { name: 'NO_PROXY', value: noProxy },
    { name: 'no_proxy', value: noProxy },
    { name: 'NODE_USE_ENV_PROXY', value: '1' },
    { name: 'JAVA_TOOL_OPTIONS', value: jvm },
  ];
}

export function isLeaseIp(ip: string): boolean {
  const match = /^198\.18\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!match) {
    return false;
  }
  const third = Number(match[1]);
  const fourth = Number(match[2]);
  return third >= 1 && third <= 250 && fourth >= 1 && fourth <= 254;
}

interface EgressDeps {
  docker: Docker;
  /** Where the server keeps the policies. The proxy container gets this directory read-only. */
  policyDir: string;
  /** The same directory as the Docker daemon sees it. */
  daemonPath: (dir: string) => Promise<string>;
  now: () => number;
  /** The unprivileged user the proxy runs as. */
  uid: number;
  /** The user of this process. A root server hands the policies to `uid`; anyone else is `uid` already. */
  own: number;
  /** Use a running proxy of the current image whoever started it. The terminal shell borrows the server's. */
  adopt?: boolean;
  /** How long a new proxy may take to listen. */
  startMs?: number;
}

/** The internal network, the proxy container on it, and one policy file per sandbox address. */
export class Egress {
  private ready: Promise<void> | null = null;
  /** Who reads the policies: `uid`, or root when the policy directory cannot be handed over. */
  private reader = 0;

  constructor(private readonly deps: EgressDeps) {}

  /** Checked before every lease, so a proxy that was removed or stopped comes back for the next step. */
  ensure(): Promise<void> {
    this.ready ??= this.setUp().finally(() => {
      this.ready = null;
    });
    return this.ready;
  }

  /** A free address with its policy written before the container exists, so the first request already has it. */
  async lease(policy: EgressPolicy): Promise<EgressLease> {
    await this.ensure();
    this.dropExpired();
    const body = `${JSON.stringify({ ...policy, expires: this.deps.now() + POLICY_TTL_MS })}\n`;
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const ip = `198.18.${randomInt(1, 251)}.${randomInt(1, 255)}`;
      const file = join(this.deps.policyDir, `${ip}.json`);
      try {
        writeFileSync(file, body, { flag: 'wx', mode: 0o600 });
      } catch {
        continue;
      }
      if (this.reader !== this.deps.own) {
        chownSync(file, this.reader, this.reader);
      }
      return { ip, release: () => rmSync(file, { force: true }) };
    }
    throw new SwarmloopError('no free sandbox address');
  }

  private dropExpired(): void {
    for (const name of readdirSync(this.deps.policyDir)) {
      const file = join(this.deps.policyDir, name);
      try {
        const expires = (JSON.parse(readFileSync(file, 'utf8')) as { expires?: number }).expires ?? 0;
        if (expires < this.deps.now()) {
          rmSync(file, { force: true });
        }
      } catch {
        continue;
      }
    }
  }

  private async setUp(): Promise<void> {
    mkdirSync(this.deps.policyDir, { recursive: true, mode: 0o700 });
    this.reader = this.readerOf(this.deps.policyDir);
    await this.ensureNetwork();
    let imageId: string;
    try {
      imageId = (await this.deps.docker(['image', 'inspect', '--format', '{{.Id}}', EGRESS_IMAGE])).trim();
    } catch {
      throw new SwarmloopError(`image ${EGRESS_IMAGE} is missing: run docker/sandbox/build.sh`);
    }
    if (await this.proxyUp(imageId)) {
      return;
    }
    await this.deps.docker(['rm', '-f', EGRESS_CONTAINER]).catch(() => '');
    const policies = await this.deps.daemonPath(this.deps.policyDir);
    try {
      await this.deps.docker([
        'run',
        '-d',
        '--name',
        EGRESS_CONTAINER,
        '--restart',
        'unless-stopped',
        '--user',
        `${this.reader}:${this.reader}`,
        '--read-only',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--pids-limit',
        '256',
        '--memory',
        '512m',
        '--log-opt',
        'max-size=10m',
        '--log-opt',
        'max-file=3',
        '--label',
        `swarmloop.image=${imageId}`,
        '--label',
        `swarmloop.user=${this.reader}`,
        '--mount',
        `type=bind,src=${policies},dst=/policies,readonly=true`,
        '--network',
        EGRESS_NETWORK,
        '--ip',
        EGRESS_IP,
        EGRESS_IMAGE,
      ]);
      await this.deps.docker(['network', 'connect', 'bridge', EGRESS_CONTAINER]);
    } catch (error) {
      if (await this.proxyUp(imageId)) {
        return;
      }
      throw new SwarmloopError(`egress proxy cannot start: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      await this.listening();
    } catch (error) {
      throw new SwarmloopError(`egress proxy cannot start: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** A sandbox that starts before the proxy listens would find no way out at all. */
  private async listening(): Promise<void> {
    let logs = '';
    for (let waited = 0; waited < (this.deps.startMs ?? 15_000); waited += 200) {
      logs = await this.deps.docker(['logs', EGRESS_CONTAINER]).catch(() => '');
      if (logs.includes('"port":3128') && logs.includes('"port":3129')) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const tail = logs.trim().split('\n').slice(-5).join(' ');
    throw new Error(`it does not listen: ${tail || 'no output'} (docker logs ${EGRESS_CONTAINER})`);
  }

  /** Running, from the current image, on the sandbox network at its address, and with a way out. */
  private async proxyUp(imageId: string): Promise<boolean> {
    try {
      const raw = await this.deps.docker([
        'inspect',
        '--format',
        '{{json .State.Running}} {{json .Config.Labels}} {{json .NetworkSettings.Networks}}',
        EGRESS_CONTAINER,
      ]);
      const [running, labels, networks] = splitJson(raw);
      const nets = (networks ?? {}) as Record<string, { IPAddress?: string }>;
      return (
        running === true &&
        (labels as Record<string, string> | null)?.['swarmloop.image'] === imageId &&
        (this.deps.adopt === true || (labels as Record<string, string>)['swarmloop.user'] === String(this.reader)) &&
        nets[EGRESS_NETWORK]?.IPAddress === EGRESS_IP &&
        nets.bridge !== undefined
      );
    } catch {
      return false;
    }
  }

  /** The proxy never runs as root when the server can hand it the directory. Policies hold keys, so never 0644. */
  private readerOf(dir: string): number {
    if (this.deps.own !== 0) {
      return this.deps.own;
    }
    try {
      chownSync(dir, this.deps.uid, this.deps.uid);
      for (const name of readdirSync(dir)) {
        chownSync(join(dir, name), this.deps.uid, this.deps.uid);
      }
      return this.deps.uid;
    } catch {
      return 0;
    }
  }

  private async ensureNetwork(): Promise<void> {
    let raw: string;
    try {
      raw = await this.deps.docker([
        'network',
        'inspect',
        '--format',
        '{{json .Internal}} {{json .IPAM.Config}}',
        EGRESS_NETWORK,
      ]);
    } catch {
      await this.deps.docker(['network', 'create', '--internal', '--subnet', EGRESS_SUBNET, EGRESS_NETWORK]);
      return;
    }
    const [internal, config] = splitJson(raw);
    const subnets = Array.isArray(config) ? (config as { Subnet?: string }[]).map((item) => item.Subnet) : [];
    if (internal !== true || !subnets.includes(EGRESS_SUBNET)) {
      throw new SwarmloopError(
        `network ${EGRESS_NETWORK} exists but is not internal on ${EGRESS_SUBNET}: remove it with docker network rm ${EGRESS_NETWORK}`,
      );
    }
  }
}

/** `docker inspect --format` with several `json` values separated by spaces. */
function splitJson(raw: string): unknown[] {
  const values: unknown[] = [];
  let rest = raw.trim();
  while (rest !== '') {
    let parsed: unknown;
    let used = 0;
    for (let end = 1; end <= rest.length; end += 1) {
      if (end < rest.length && rest[end] !== ' ') {
        continue;
      }
      try {
        parsed = JSON.parse(rest.slice(0, end));
        used = end;
        break;
      } catch {
        continue;
      }
    }
    if (used === 0) {
      break;
    }
    values.push(parsed);
    rest = rest.slice(used).trim();
  }
  return values;
}
