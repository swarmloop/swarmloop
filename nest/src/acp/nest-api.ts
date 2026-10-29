export interface RunRow {
  key: string;
  status: string;
  currentStep: string;
  updatedAt: string;
  usd: number;
}

export interface FlowStep {
  name: string;
  status: string;
}

export interface FlowView {
  key: string;
  status: string;
  currentStep: string;
  updatedAt: string;
  sentence: string;
  phases?: { phase: string; steps: FlowStep[] }[];
}

export interface NestApi {
  list(): Promise<{ runs: RunRow[] }>;
  flow(key: string): Promise<FlowView>;
  create(body: { prompt?: string; path?: string; projects?: string[] }): Promise<{ key: string; status: string }>;
  chat(key: string, body: { prompt: string; skill?: string; cwd?: string; mcpServers?: unknown }): Promise<{ text: string }>;
  step(key: string, step: string, body: { prompt?: string }): Promise<{ key: string; status: string }>;
  replay(key: string, step: string, body: { prompt: string }): Promise<{ key: string; status: string }>;
  resume(key: string, body?: { prompt?: string }): Promise<{ key: string; status: string }>;
  stop(key: string): Promise<{ key: string; status: string }>;
  shellOpen(body: { path: string }): Promise<ShellFeature | { matches: ShellMatch[] }>;
  shellFeature(key: string): Promise<ShellFeature>;
  shellLock(key: string, container: string): Promise<{ status: string }>;
  shellUnlock(key: string): Promise<{ status: string }>;
  snapshots(key: string): Promise<{ snapshots: { id: number; step: string; at: string }[] }>;
  rewind(key: string, id: number): Promise<{ step: string }>;
}

export interface ShellMatch {
  key: string;
  status: string;
  currentStep: string;
}

export interface ShellFeature {
  key: string;
  created: boolean;
  status: string;
  currentStep: string;
  runtime: string;
  resumeChatId: string | null;
  mounts: { hostPath: string; containerPath: string }[];
}

export class HttpNestApi implements NestApi {
  constructor(
    private readonly base: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  list(): Promise<{ runs: RunRow[] }> {
    return this.send('GET', '/runs');
  }

  flow(key: string): Promise<FlowView> {
    return this.send('GET', `/runs/${encodeURIComponent(key)}`);
  }

  create(body: { prompt?: string; path?: string; projects?: string[] }): Promise<{ key: string; status: string }> {
    return this.send('POST', '/runs', body);
  }

  chat(key: string, body: { prompt: string; skill?: string; cwd?: string; mcpServers?: unknown }): Promise<{ text: string }> {
    return this.send('POST', `/runs/${encodeURIComponent(key)}/chat`, body);
  }

  step(key: string, step: string, body: { prompt?: string }): Promise<{ key: string; status: string }> {
    return this.send('POST', `/runs/${encodeURIComponent(key)}/steps/${encodeURIComponent(step)}`, body);
  }

  replay(key: string, step: string, body: { prompt: string }): Promise<{ key: string; status: string }> {
    return this.send('POST', `/runs/${encodeURIComponent(key)}/steps/${encodeURIComponent(step)}/replay`, body);
  }

  resume(key: string, body?: { prompt?: string }): Promise<{ key: string; status: string }> {
    return this.send('POST', `/runs/${encodeURIComponent(key)}/resume`, body ?? {});
  }

  stop(key: string): Promise<{ key: string; status: string }> {
    return this.send('POST', `/runs/${encodeURIComponent(key)}/stop`, {});
  }

  shellOpen(body: { path: string }): Promise<ShellFeature | { matches: ShellMatch[] }> {
    return this.send('POST', '/runs/shell', body);
  }

  shellFeature(key: string): Promise<ShellFeature> {
    return this.send('GET', `/runs/${encodeURIComponent(key)}/shell`);
  }

  shellLock(key: string, container: string): Promise<{ status: string }> {
    return this.send('POST', `/runs/${encodeURIComponent(key)}/shell/lock`, { container });
  }

  shellUnlock(key: string): Promise<{ status: string }> {
    return this.send('POST', `/runs/${encodeURIComponent(key)}/shell/unlock`, {});
  }

  snapshots(key: string): Promise<{ snapshots: { id: number; step: string; at: string }[] }> {
    return this.send('GET', `/runs/${encodeURIComponent(key)}/snapshots`);
  }

  rewind(key: string, id: number): Promise<{ step: string }> {
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
