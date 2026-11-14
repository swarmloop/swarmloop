import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { assertAgents } from '../config/agents';
import { testEnv } from '../config/env.spec-helpers';
import { FakeClock } from '../core/fake-clock.spec-helpers';
import type { SandboxService } from '../sandbox/sandbox.service';
import { warmRuntimeModelLists } from './model-lists.bootstrap';

describe('warmRuntimeModelLists', () => {
  it('lets the start go on with no model key when the shipped lists name an effort', async () => {
    const root = await mkdtemp(join(tmpdir(), 'model-lists-'));
    const env = testEnv({
      SWARMLOOP_ROOT: root,
      AGENTS_PLAN: 'claude:claude-opus-5-5:high',
      AGENTS_IMPLEMENT: 'claude:claude-sonnet-5-5:high',
      AGENTS_REVIEW: 'claude:claude-opus-5-5:high',
      ANTHROPIC_API_KEY: '',
      CLAUDE_CODE_OAUTH_TOKEN: '',
      CURSOR_API_KEY: '',
    });
    const sandbox = { run: () => Promise.reject(new Error('no credential: the CLI must not start')) };
    await expect(
      warmRuntimeModelLists(env, sandbox as unknown as SandboxService, new FakeClock()),
    ).resolves.toBeUndefined();
    expect(() => assertAgents(env)).not.toThrow();
  });
});
