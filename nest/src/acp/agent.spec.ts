import { mkdirSync, writeFileSync } from 'fs';
import { mkdtemp, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { Writable } from 'stream';
import { panelUrl, planEntries, progressText, serve, Sloop } from './agent';
import { encodeMessage, pushFrames } from './framing';
import { HttpNestApi, NestApi } from './nest-api';
import { nestCheckout } from './paths';

describe('sloop', () => {
  it('names the phase and the step', () => {
    const flow = {
      key: 'PROJ-1',
      status: 'running',
      currentStep: 'research',
      updatedAt: '2026-10-17T19:04:00.000Z',
      sentence: 'This step is running. The output is below.',
      phases: [
        { phase: 'requirements', steps: [{ name: 'requirements', status: 'done' }] },
        {
          phase: 'planning',
          steps: [
            { name: 'prepare', status: 'done' },
            { name: 'research', status: 'running' },
            { name: 'branch', status: 'idle' },
          ],
        },
      ],
    };
    expect(progressText(flow)).toBe('PROJ-1 · planning · research — running\n');
    expect(progressText({ ...flow, sentence: 'Answer the open questions before the run continues.' })).toBe(
      'PROJ-1 · planning · research — running\n\nAnswer the open questions before the run continues.\n',
    );
    expect(planEntries(flow)).toContainEqual({ content: 'planning · research — running', priority: 'high', status: 'in_progress' });
  });

  it('frames json-rpc as one line', () => {
    const encoded = encodeMessage({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect(encoded.toString('utf8')).toBe('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
    const split = pushFrames(Buffer.alloc(0), encoded.subarray(0, 12));
    expect(split.messages).toEqual([]);
    const parsed = pushFrames(split.buffer, encoded.subarray(12));
    expect(parsed.messages).toEqual([{ jsonrpc: '2.0', id: 1, method: 'initialize' }]);
    expect(parsed.buffer).toEqual(Buffer.alloc(0));
    const crlf = pushFrames(Buffer.alloc(0), Buffer.from('{"jsonrpc":"2.0","id":2,"method":"initialize"}\r\n'));
    expect(crlf.messages).toEqual([{ jsonrpc: '2.0', id: 2, method: 'initialize' }]);
  });

  it('maps a host checkout into the nest mount', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sloop-path-'));
    const demo = join(root, 'checkouts', 'demo');
    const tree = join(root, 'repo', 'worktrees', 'PROJ-1');
    await mkdir(demo, { recursive: true });
    await mkdir(tree, { recursive: true });
    expect(nestCheckout(demo, join(root, 'repo'), join(root, 'checkouts'))).toBe('/checkouts/demo');
    expect(nestCheckout(tree, join(root, 'repo'), join(root, 'checkouts'))).toBe('/app/worktrees/PROJ-1');
    expect(nestCheckout(join(root, 'repo'), join(root, 'repo'), join(root, 'checkouts'))).toContain(root);
  });

  it('answers initialize and lists features from nest', async () => {
    const { agent, notes } = harness({
      list: async () => ({
        runs: [{ key: 'PROJ-1', status: 'running', currentStep: 'research', updatedAt: '2026-10-17T19:04:00.000Z', usd: 0.14 }],
      }),
    });
    const init = await agent.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 2 } }, note(notes));
    expect(init).toMatchObject({ id: 1, result: { protocolVersion: 2, agentInfo: { name: 'sloop' } } });
    const listed = await agent.handle(
      { jsonrpc: '2.0', id: 2, method: 'session/list', params: { cwd: '/work/app' } },
      note(notes),
    );
    const sessions = (listed as { result: { sessions: { sessionId: string; cwd: string; title: string }[] } }).result.sessions;
    expect(sessions[0].sessionId).toBe('PROJ-1');
    expect(sessions[0].cwd).toBe('/work/app');
    expect(sessions[0].title).toContain('$0.14 · PROJ-1 · running · research');
  });

  it('resumes the latest run when this chat has none', async () => {
    const calls: string[] = [];
    const { agent, notes } = harness({
      list: async () => ({
        runs: [
          { key: 'PROJ-2', status: 'waiting', currentStep: 'research', updatedAt: '2026-10-17T19:04:00.000Z', usd: 0.14 },
          { key: 'PROJ-1', status: 'failed', currentStep: 'branch', updatedAt: '2026-10-18T10:20:46.936Z', usd: 0.02 },
        ],
      }),
      resume: async (key) => {
        calls.push(key);
        return { key, status: 'started' };
      },
    });
    await agent.handle({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: '/work/app' } }, note(notes));
    await agent.handle(
      { jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: 'sloop-1-0', prompt: [{ type: 'text', text: '/resume' }] } },
      note(notes),
    );
    expect(calls).toEqual(['PROJ-1']);
    expect(text(notes)).toContain('PROJ-1 resumed');
  });

  it('says when nest is not running', async () => {
    const { agent } = harness({
      list: async () => {
        throw new Error('nest is not running');
      },
    });
    const listed = await agent.handle({ jsonrpc: '2.0', id: 2, method: 'session/list' }, () => undefined);
    expect(listed).toMatchObject({ error: { message: 'nest is not running' } });
  });

  it('starts a feature from the first prompt and keeps the same run', async () => {
    const created: unknown[] = [];
    const { agent, notes, api } = harness({
      create: async (body) => {
        created.push(body);
        return { key: 'PROJ-1', status: 'started' };
      },
      flow: flipping(),
    });
    const folder = await mkdtemp(join(tmpdir(), 'sloop-demo-'));
    await mkdir(join(folder, '.git'));
    await agent.handle({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: folder, mcpServers: [] } }, note(notes));
    const prompted = await agent.handle(
      { jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: 'sloop-1-0', prompt: [{ type: 'text', text: 'Ship the field' }] } },
      note(notes),
    );
    expect(created).toEqual([{ prompt: 'Ship the field', projects: [basename(folder)] }]);
    expect(prompted).toMatchObject({ result: { stopReason: 'end_turn' } });
    expect(text(notes)).toContain(`${panelUrl(null)}\n`);
    const titleAt = notes.findIndex((item) => (item.params as { update?: { title?: string } })?.update?.title === 'PROJ-1');
    const startedAt = notes.findIndex((item) => JSON.stringify(item).includes('PROJ-1 started'));
    expect(titleAt).toBeGreaterThanOrEqual(0);
    expect(startedAt).toBeGreaterThan(titleAt);
    expect(text(notes)).toContain('PROJ-1 started');
    expect(text(notes)).toContain(panelUrl('PROJ-1'));
    expect(text(notes)).toContain('research is waiting');
    const chats: unknown[] = [];
    api.chat = async (key, body) => {
      chats.push({ key, body });
      return { text: 'noted' };
    };
    await agent.handle(
      { jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: 'sloop-1-0', prompt: [{ type: 'text', text: 'why?' }] } },
      note(notes),
    );
    expect(chats).toEqual([{ key: 'PROJ-1', body: { prompt: 'why?', skill: undefined, cwd: folder, mcpServers: [] } }]);
  });

  it('loads a feature log, replays it, reviews a checkout, and runs a step', async () => {
    const calls: string[] = [];
    const { agent, notes } = harness({
      replay: async (key, step, body) => {
        calls.push(`replay ${key} ${step} ${body.prompt}`);
        return { key, status: 'started' };
      },
      resume: async (key) => {
        calls.push(`resume ${key}`);
        return { key, status: 'started' };
      },
      step: async (key, step, body) => {
        calls.push(`step ${key} ${step} ${body.prompt ?? ''}`);
        return { key, status: 'started' };
      },
      create: async (body) => {
        calls.push(`create ${body.path ?? ''} ${body.prompt ?? ''}`);
        return { key: 'PROJ-9', status: 'started' };
      },
      chat: async (_key, body) => {
        calls.push(`chat ${body.skill ?? ''} ${body.prompt}`);
        return { text: 'skill ran' };
      },
    });
    const loaded = await agent.handle(
      { jsonrpc: '2.0', id: 1, method: 'session/load', params: { sessionId: 'PROJ-1', cwd: '/no/such/sloop-demo' } },
      note(notes),
    );
    expect(loaded).toMatchObject({ result: { sessionId: 'PROJ-1' } });
    expect(text(notes)).toContain(panelUrl('PROJ-1'));
    expect(text(notes)).toContain('PROJ-1 · planning · research — waiting');
    expect(notes.some((item) => (item.params as { update?: { sessionUpdate?: string; title?: string } })?.update?.sessionUpdate === 'session_info_update')).toBe(true);
    expect(text(notes)).toContain('research is waiting');
    expect(text(notes)).not.toContain('- brainstorm');
    expect(notes.some((item) => (item.params as { update?: { sessionUpdate?: string } })?.update?.sessionUpdate === 'plan')).toBe(true);
    await agent.handle(
      { jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: 'PROJ-1', prompt: [{ type: 'text', text: '/replay Ship it again' }] } },
      note(notes),
    );
    await agent.handle(
      { jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: 'PROJ-1', prompt: [{ type: 'text', text: '/step commit check the form' }] } },
      note(notes),
    );
    await agent.handle(
      { jsonrpc: '2.0', id: 4, method: 'session/prompt', params: { sessionId: 'PROJ-1', prompt: [{ type: 'text', text: '/research' }] } },
      note(notes),
    );
    await agent.handle(
      { jsonrpc: '2.0', id: 6, method: 'session/prompt', params: { sessionId: 'PROJ-1', prompt: [{ type: 'text', text: '/resume' }] } },
      note(notes),
    );
    await agent.handle(
      { jsonrpc: '2.0', id: 5, method: 'session/prompt', params: { sessionId: 'PROJ-1', prompt: [{ type: 'text', text: '/review look at the branch' }] } },
      note(notes),
    );
    expect(calls).toEqual([
      'replay PROJ-1 requirements Ship it again',
      'step PROJ-1 commit check the form',
      'chat research Follow the skill.',
      'resume PROJ-1',
      'create /no/such/sloop-demo look at the branch',
    ]);
  });

  it('streams the agent log while a step is running', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sloop-watch-'));
    mkdirSync(join(root, 'data'));
    writeFileSync(
      join(root, 'data', 'PROJ-1-implement-improve-swarmloop-output.txt'),
      `${JSON.stringify({ type: 'thinking', subtype: 'delta', text: 'Reviewing the diff.' })}\n`,
    );
    const { agent, notes } = harness(
      {
        create: async () => ({ key: 'PROJ-1', status: 'started' }),
        flow: flippingStep('implement-improve'),
      },
      undefined,
      root,
    );
    const folder = await mkdtemp(join(tmpdir(), 'sloop-demo-'));
    await mkdir(join(folder, '.git'));
    await agent.handle({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: folder } }, note(notes));
    await agent.handle(
      { jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: 'sloop-1-0', prompt: [{ type: 'text', text: 'Ship' }] } },
      note(notes),
    );
    expect(text(notes)).toContain('thinking');
    expect(text(notes)).toContain('Reviewing the diff.');
  });

  it('streams each code reviewer, not the empty parent log', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sloop-review-'));
    mkdirSync(join(root, 'data'));
    writeFileSync(
      join(root, 'data', 'PROJ-1-code-review-quality-output.txt'),
      `${JSON.stringify({ type: 'tool_call', subtype: 'started', tool_call: { readToolCall: { args: { path: '/work/swarmloop/next/components/shell.tsx' } } } })}\n`,
    );
    writeFileSync(
      join(root, 'data', 'PROJ-1-code-review-requirements-output.txt'),
      `${JSON.stringify({ type: 'thinking', subtype: 'delta', text: 'Carefully reviewing against the requirements.' })}\n`,
    );
    const { agent, notes } = harness(
      {
        create: async () => ({ key: 'PROJ-1', status: 'started' }),
        flow: flippingStep('code-review', 'code-review'),
      },
      undefined,
      root,
    );
    const folder = await mkdtemp(join(tmpdir(), 'sloop-demo-'));
    await mkdir(join(folder, '.git'));
    await agent.handle({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: folder } }, note(notes));
    await agent.handle(
      { jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: 'sloop-1-0', prompt: [{ type: 'text', text: 'Ship' }] } },
      note(notes),
    );
    const said = text(notes);
    expect(said).toContain('quality');
    expect(said).toContain('/work/swarmloop/next/components/shell.tsx');
    expect(said).toContain('requirements');
    expect(said).toContain('Carefully reviewing against the requirements.');
  });

  it('waits until a new feature row exists', async () => {
    let polls = 0;
    const { agent, notes } = harness({
      create: async () => ({ key: 'PROJ-1', status: 'started' }),
      flow: async () => {
        polls += 1;
        if (polls < 3) {
          throw new Error('PROJ-1 is missing');
        }
        return {
          key: 'PROJ-1',
          status: 'waiting',
          currentStep: 'research',
          updatedAt: '2026-10-17T19:04:00.000Z',
          sentence: 'research is waiting',
          phases: [],
        };
      },
    });
    const folder = await mkdtemp(join(tmpdir(), 'sloop-demo-'));
    await mkdir(join(folder, '.git'));
    await agent.handle({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: folder } }, note(notes));
    const prompted = await agent.handle(
      { jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: 'sloop-1-0', prompt: [{ type: 'text', text: 'Ship' }] } },
      note(notes),
    );
    expect(polls).toBe(3);
    expect(prompted).toMatchObject({ result: { stopReason: 'end_turn' } });
    expect(text(notes)).toContain('research is waiting');
  });

  it('reviews a directory named after the command', async () => {
    const created: string[] = [];
    const { agent } = harness({
      create: async (body) => {
        created.push(`${body.path ?? ''} ${body.prompt ?? ''}`);
        return { key: 'PROJ-9', status: 'done' };
      },
    });
    await agent.handle({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: '/no/such/sloop-demo' } }, () => undefined);
    await agent.handle(
      { jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: 'sloop-1-0', prompt: [{ type: 'text', text: '/review ./other look here' }] } },
      () => undefined,
    );
    expect(created).toEqual(['/no/such/sloop-demo/other look here']);
  });

  it('stops the feature when the session is cancelled', async () => {
    let release = (): void => undefined;
    const stopped: string[] = [];
    const { agent } = harness({
      create: async () => ({ key: 'PROJ-1', status: 'started' }),
      flow: async () => ({
        key: 'PROJ-1',
        status: 'running',
        currentStep: 'research',
        updatedAt: '2026-10-17T19:04:00.000Z',
        sentence: 'working',
        phases: [],
      }),
      stop: async (key) => {
        stopped.push(key);
        return { key, status: 'stopped' };
      },
    }, async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const folder = await mkdtemp(join(tmpdir(), 'sloop-demo-'));
    await mkdir(join(folder, '.git'));
    await agent.handle({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: folder } }, () => undefined);
    const pending = agent.handle(
      { jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: 'sloop-1-0', prompt: [{ type: 'text', text: 'Ship' }] } },
      () => undefined,
    );
    await new Promise((resolve) => setImmediate(resolve));
    await agent.handle({ jsonrpc: '2.0', id: 3, method: 'session/cancel', params: { sessionId: 'sloop-1-0' } }, () => undefined);
    release();
    await pending;
    expect(stopped).toEqual(['PROJ-1']);
  });

  it('ends a chat as cancelled when stop interrupts it', async () => {
    let release = (): void => undefined;
    const { agent } = harness({
      chat: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        throw new Error('chat failed');
      },
    });
    await agent.handle({ jsonrpc: '2.0', id: 1, method: 'session/load', params: { sessionId: 'PROJ-1', cwd: '/no/such/sloop-demo' } }, () => undefined);
    const pending = agent.handle(
      { jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: 'PROJ-1', prompt: [{ type: 'text', text: 'hi' }] } },
      () => undefined,
    );
    await new Promise((resolve) => setImmediate(resolve));
    await agent.handle({ jsonrpc: '2.0', id: 3, method: 'session/cancel', params: { sessionId: 'PROJ-1' } }, () => undefined);
    release();
    await expect(pending).resolves.toMatchObject({ result: { stopReason: 'cancelled' } });
  });

  it('reports a nest error from the http client', async () => {
    const fetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;
    fetchImpl.mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ message: 'prompt is missing' }) } as Response);
    const api = new HttpNestApi('http://127.0.0.1:3920', fetchImpl);
    await expect(api.create({ prompt: '' })).rejects.toThrow('prompt is missing');
    fetchImpl.mockRejectedValueOnce(new Error('connect failed'));
    await expect(api.list()).rejects.toThrow('nest is not running');
  });
});

function note(notes: { method?: string; params?: unknown }[]): (message: { method?: string; params?: unknown }) => void {
  return (message) => notes.push(message);
}

function text(notes: { params?: unknown }[]): string {
  return notes
    .map((item) => {
      const params = item.params as { update?: { content?: { text?: string } } } | undefined;
      return params?.update?.content?.text ?? '';
    })
    .join('');
}

function flipping(): NestApi['flow'] {
  return flippingStep('research', 'brainstorm');
}

function flippingStep(step: string, phase = 'implementation'): NestApi['flow'] {
  let polls = 0;
  return async () => {
    polls += 1;
    const running = polls === 1;
    return {
      key: 'PROJ-1',
      status: running ? 'running' : 'waiting',
      currentStep: step,
      updatedAt: '2026-10-17T19:04:00.000Z',
      sentence: `${step} is waiting`,
      phases: [{ phase, steps: [{ name: step, status: running ? 'running' : 'done' }] }],
    };
  };
}

function harness(
  api: Partial<NestApi>,
  sleep?: () => Promise<void>,
  repoRoot = '/tmp/swarmloop',
): { agent: Sloop; notes: { method?: string; params?: unknown }[]; api: NestApi } {
  const full: NestApi = {
    list: async () => ({ runs: [] }),
    flow: async () => ({
      key: 'PROJ-1',
      status: 'waiting',
      currentStep: 'research',
      updatedAt: '2026-10-17T19:04:00.000Z',
      sentence: 'research is waiting',
      phases: [{ phase: 'planning', steps: [{ name: 'research', status: 'done' }] }],
    }),
    create: async () => ({ key: 'PROJ-1', status: 'started' }),
    chat: async () => ({ text: 'ok' }),
    step: async (key) => ({ key, status: 'started' }),
    replay: async (key) => ({ key, status: 'started' }),
    resume: async (key) => ({ key, status: 'started' }),
    stop: async (key) => ({ key, status: 'stopped' }),
    shellOpen: async () => ({
      key: 'PROJ-1',
      created: false,
      status: 'waiting',
      currentStep: 'requirements',
      runtime: 'cursor',
      resumeChatId: null,
      mounts: [],
    }),
    shellFeature: async (key) => ({
      key,
      created: false,
      status: 'waiting',
      currentStep: 'requirements',
      runtime: 'cursor',
      resumeChatId: null,
      mounts: [],
    }),
    shellLock: async () => ({ status: 'running' }),
    shellUnlock: async () => ({ status: 'waiting' }),
    snapshots: async () => ({ snapshots: [] }),
    rewind: async () => ({ step: 'requirements' }),
    ...api,
  };
  const notes: { method?: string; params?: unknown }[] = [];
  const agent = new Sloop({
    api: full,
    skills: [{ name: 'research', description: 'Read the ticket' }],
    repoRoot,
    checkoutsRoot: '/tmp/outside',
    cwd: '/tmp/demo',
    sleep: sleep ?? (async () => undefined),
    intervalMs: 0,
    now: () => 1,
  });
  return { agent, notes, api: full };
}

describe('stdio serve', () => {
  it('reads cancel while a prompt is still running', async () => {
    let unlock = (): void => undefined;
    const release = (): void => unlock();
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      started = resolve;
    });
    const stopped: string[] = [];
    const { agent } = harness(
      {
        create: async () => ({ key: 'PROJ-1', status: 'started' }),
        flow: async () => ({
          key: 'PROJ-1',
          status: 'running',
          currentStep: 'research',
          updatedAt: '2026-10-17T19:04:00.000Z',
          sentence: 'working',
          phases: [],
        }),
        stop: async (key) => {
          stopped.push(key);
          return { key, status: 'stopped' };
        },
      },
      async () => {
        started();
        await new Promise<void>((resolve) => {
          unlock = resolve;
        });
      },
    );
    const chunks: Buffer[] = [];
    const output = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });
    const folder = await mkdtemp(join(tmpdir(), 'sloop-demo-'));
    await mkdir(join(folder, '.git'));
    await serve(frames(gate, release, folder), output, agent);
    expect(stopped).toEqual(['PROJ-1']);
    const parsed = pushFrames(Buffer.alloc(0), Buffer.concat(chunks));
    expect(parsed.messages.find((message) => message.id === 2)).toMatchObject({ result: { stopReason: 'cancelled' } });
  });

  it('writes a framed initialize response', async () => {
    const chunks: Buffer[] = [];
    const output = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });
    const { agent } = harness({});
    await serveOnce(agent, output, encodeMessage({ jsonrpc: '2.0', id: 7, method: 'initialize', params: { protocolVersion: 1 } }));
    const parsed = pushFrames(Buffer.alloc(0), Buffer.concat(chunks));
    expect(parsed.messages[0]).toMatchObject({ id: 7, result: { protocolVersion: 1 } });
  });
});

async function serveOnce(agent: Sloop, output: Writable, payload: Buffer): Promise<void> {
  await serve([payload], output, agent);
}

async function* frames(gate: Promise<void>, release: () => void, cwd: string): AsyncGenerator<Buffer> {
  yield encodeMessage({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd } });
  yield encodeMessage({
    jsonrpc: '2.0',
    id: 2,
    method: 'session/prompt',
    params: { sessionId: 'sloop-1-0', prompt: [{ type: 'text', text: 'Ship' }] },
  });
  await gate;
  yield encodeMessage({ jsonrpc: '2.0', id: 3, method: 'session/cancel', params: { sessionId: 'sloop-1-0' } });
  release();
}
