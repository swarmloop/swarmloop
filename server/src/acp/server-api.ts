import {
  ChatBody,
  ChatView,
  CreateRunBody,
  FlowView,
  OpenShellBody,
  ReplayBody,
  ResumeBody,
  RewindView,
  RunRef,
  RunsView,
  ShellFeature,
  ShellMatch,
  ShellStatusView,
  SnapshotsView,
  StartStepBody,
} from '../contract/api';

export interface ServerApi {
  list(): Promise<RunsView>;
  flow(key: string): Promise<FlowView>;
  create(body: CreateRunBody): Promise<RunRef>;
  chat(key: string, body: ChatBody): Promise<ChatView>;
  step(key: string, step: string, body: StartStepBody): Promise<RunRef>;
  replay(key: string, step: string, body: ReplayBody): Promise<RunRef>;
  resume(key: string, body?: ResumeBody): Promise<RunRef>;
  stop(key: string): Promise<RunRef>;
  shellOpen(body: OpenShellBody): Promise<ShellFeature | { matches: ShellMatch[] }>;
  shellFeature(key: string): Promise<ShellFeature>;
  shellLock(key: string, container: string): Promise<ShellStatusView>;
  shellUnlock(key: string): Promise<ShellStatusView>;
  snapshots(key: string): Promise<SnapshotsView>;
  rewind(key: string, id: number): Promise<RewindView>;
}

export class HttpServerApi implements ServerApi {
  constructor(
    private readonly base: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  list(): Promise<RunsView> {
    return this.send('GET', '/runs');
  }

  flow(key: string): Promise<FlowView> {
    return this.send('GET', `/runs/${encodeURIComponent(key)}`);
  }

  create(body: CreateRunBody): Promise<RunRef> {
    return this.send('POST', '/runs', body);
  }

  chat(key: string, body: ChatBody): Promise<ChatView> {
    return this.send('POST', `/runs/${encodeURIComponent(key)}/chat`, body);
  }

  step(key: string, step: string, body: StartStepBody): Promise<RunRef> {
    return this.send('POST', `/runs/${encodeURIComponent(key)}/steps/${encodeURIComponent(step)}`, body);
  }

  replay(key: string, step: string, body: ReplayBody): Promise<RunRef> {
    return this.send('POST', `/runs/${encodeURIComponent(key)}/steps/${encodeURIComponent(step)}/replay`, body);
  }

  resume(key: string, body?: ResumeBody): Promise<RunRef> {
    return this.send('POST', `/runs/${encodeURIComponent(key)}/resume`, body ?? {});
  }

  stop(key: string): Promise<RunRef> {
    return this.send('POST', `/runs/${encodeURIComponent(key)}/stop`, {});
  }

  shellOpen(body: OpenShellBody): Promise<ShellFeature | { matches: ShellMatch[] }> {
    return this.send('POST', '/runs/shell', body);
  }

  shellFeature(key: string): Promise<ShellFeature> {
    return this.send('GET', `/runs/${encodeURIComponent(key)}/shell`);
  }

  shellLock(key: string, container: string): Promise<ShellStatusView> {
    return this.send('POST', `/runs/${encodeURIComponent(key)}/shell/lock`, { container });
  }

  shellUnlock(key: string): Promise<ShellStatusView> {
    return this.send('POST', `/runs/${encodeURIComponent(key)}/shell/unlock`, {});
  }

  snapshots(key: string): Promise<SnapshotsView> {
    return this.send('GET', `/runs/${encodeURIComponent(key)}/snapshots`);
  }

  rewind(key: string, id: number): Promise<RewindView> {
    return this.send('POST', `/runs/${encodeURIComponent(key)}/rewind`, { id });
  }

  private async send<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error('nest is not running');
    }
    const payload = (await response.json().catch(() => ({}))) as { message?: unknown };
    if (!response.ok) {
      throw new Error(text(payload.message) || `nest returned ${response.status}`);
    }
    return payload as T;
  }
}

function text(message: unknown): string {
  if (typeof message === 'string') {
    return message;
  }
  if (Array.isArray(message)) {
    return message.map((item) => String(item)).join('\n');
  }
  return '';
}
