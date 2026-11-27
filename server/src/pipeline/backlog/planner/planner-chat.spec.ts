import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Agent } from '../../../config/agents';
import { sessionFileName, sessionHome } from '../../../history/session-group';
import { agentStateDir } from '../../../sandbox/sandbox-launch';
import { plannerChatFor } from './planner-chat';
import { plannerChatKey } from './planner-chat-key';

const AGENT: Agent = { runtime: 'claude', model: 'claude-opus-5-5', effort: 'high' };
const KEY = plannerChatKey(7);

type Last = { runtime: string; model: string; effort: string | null; lastPromptTokens: number | null };
const lastOf = (over: Partial<Last> = {}): Last => ({
  runtime: 'claude',
  model: 'claude-opus-5-5',
  effort: 'high',
  lastPromptTokens: 1000,
  ...over,
});

describe('plannerChatFor', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'planner-chat-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** A stored chat of the backlog: its session file and its CLI state folder. */
  function storeChat(runtime = 'claude'): void {
    mkdirSync(join(root, 'data'), { recursive: true });
    mkdirSync(agentStateDir(root, KEY, sessionHome('backlog-plan')), { recursive: true });
    writeFileSync(
      join(root, 'data', sessionFileName(KEY, 'backlog-plan')),
      JSON.stringify({ runtime, chatId: 'chat-1', resumed: true, completed: true, killReason: null }),
    );
  }
  const ask = (last: Last | null, agent: Agent = AGENT, share = 0.5) =>
    plannerChatFor({ root, share, calls: { lastCallOfChat: async () => last as never } }, 7, agent);

  it('resumes the stored chat of the backlog that the same agent last used and that is under its share', async () => {
    storeChat();
    expect(await ask(lastOf({ lastPromptTokens: 499_999 }))).toEqual({ chatKey: KEY, resume: true, reason: null });
  });

  it('starts anew when no chat is stored', async () => {
    expect(await ask(lastOf())).toEqual({ chatKey: KEY, resume: false, reason: 'no stored chat' });
  });

  it('starts anew when the chat state folder is gone or the call log has no call of the chat', async () => {
    storeChat();
    expect((await ask(null)).reason).toBe('no stored chat');
    rmSync(agentStateDir(root, KEY, sessionHome('backlog-plan')), { recursive: true });
    expect((await ask(lastOf())).reason).toBe('no stored chat');
  });

  it('starts anew on another runtime, model or effort than the chat last ran on', async () => {
    storeChat();
    expect((await ask(lastOf({ model: 'claude-sonnet-5-5' }))).reason).toBe('agent changed');
    expect((await ask(lastOf({ effort: 'xhigh' }))).reason).toBe('agent changed');
    expect((await ask(lastOf({ runtime: 'codex' }))).reason).toBe('agent changed');
    expect((await ask(lastOf(), { runtime: 'codex', model: 'gpt' })).reason).toBe('no stored chat');
  });

  it('starts anew when the last prompt reached its share of the context', async () => {
    storeChat();
    const past = await ask(lastOf({ lastPromptTokens: 500_000 }));
    expect(past).toEqual({ chatKey: KEY, resume: false, reason: 'chat past its size limit' });
    expect((await ask(lastOf({ lastPromptTokens: 500_000 }), AGENT, 0.6)).resume).toBe(true);
  });

  it('starts anew when the size of the model context is not known', async () => {
    storeChat('codex');
    const agent: Agent = { runtime: 'codex', model: 'unknown-model' };
    const last = lastOf({ runtime: 'codex', model: 'unknown-model', effort: null });
    expect((await ask(last, agent)).reason).toBe('chat past its size limit');
  });
});
