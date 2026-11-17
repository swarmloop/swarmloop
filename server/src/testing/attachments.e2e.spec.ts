import 'reflect-metadata';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgentLaunchPrep } from '../agent/agent-launch-prep';
import { PlanChatService } from '../api/plan-chat.service';
import { RunsController } from '../api/runs.controller';
import { AppConfig } from '../config/env';
import { testEnv } from '../config/env.spec-helpers';
import { attachmentsDir } from '../history/run-paths';
import { AttachmentStore } from '../history/attachment-store';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { ClaudeRuntime } from '../integrations/agent-runtime/claude/claude.runtime';
import { createFlowHarness } from './flow-harness';
import { BlockAgentRunner } from './result-answer';
import { remember } from './runs.spec-helpers';

const KEY = 'PROJ-490';
const LIST = '/work/brief/attachments';

describe('files with a message or a new run', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;
  let blocks: BlockAgentRunner;

  beforeEach(async () => {
    blocks = new BlockAgentRunner();
    flow = await createFlowHarness(KEY, {
      blocks,
      realImplement: 'all',
      realReview: true,
      env: { ANTHROPIC_API_KEY: 'sk-ant-test-key-0123456789' },
    });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.close();
  });

  const stage = (name: string, text: string) => flow.app.app.get(AttachmentStore).stage(name, Buffer.from(text));

  /** The mounts the real launch prep gives a visit of this run. */
  function mountsOf(step: string): string[] {
    const config = flow.app.app.get(AppConfig);
    const prep = new AgentLaunchPrep(new AppConfig(testEnv({ SWARMLOOP_ROOT: config.env.SWARMLOOP_ROOT })));
    const launch = prep.prepare(
      {
        prompt: 'short',
        workspace: flow.tree,
        outputFile: join(mkdtempSync(join(tmpdir(), 'attachments-')), 'out.txt'),
        sessionFile: join(flow.app.root, 'session.json'),
        runtime: 'claude',
        model: 'claude-sonnet-5-5',
        agentCalls: 0,
        spentUsd: 0,
        tokensInRun: 0,
        resumeChatId: null,
        runKey: KEY,
        step,
        attemptId: 'attempt-1',
        mounts: [{ hostPath: flow.tree, containerPath: '/work/demo' }],
        tools: 'write',
      },
      new ClaudeRuntime(),
      false,
    );
    return launch.mounts.map((mount) => `${mount.containerPath}${mount.readonly ? ' (read only)' : ''}`);
  }

  it('a file sent with a message is in the attachments folder for the next agents, listed in their prompts', async () => {
    const runs = flow.app.app.get(RunRepository);
    await remember(runs, flow.app.app.get(DocumentRepository), KEY, 'research', 'waiting');
    const file = await stage('notes.txt', 'the notes');
    await flow.app.app.get(PlanChatService).send(KEY, 'see the notes', 'ann', undefined, [file.id]);

    await flow.person('resume');

    expect((await runs.findRun(KEY))!.status).toBe('done');
    expect(readFileSync(join(attachmentsDir(flow.app.app.get(AppConfig), KEY), 'notes.txt'), 'utf8')).toBe('the notes');
    expect(blocks.prompts.length).toBeGreaterThan(5);
    for (const { step, prompt } of blocks.prompts) {
      expect([step, prompt]).toEqual([step, expect.stringContaining(`Attachments:\n`)]);
      expect(prompt).toContain(`- ${LIST}/notes.txt`);
    }
    expect(mountsOf('implement')).toContain(`${LIST} (read only)`);
    expect(mountsOf('code-review-requirements')).toContain(`${LIST} (read only)`);
  });

  it('a file given to a new run reaches the run agents the same way', async () => {
    const file = await stage('shot.png', 'png');
    const sent = await flow.app.app
      .get(RunsController)
      .create(
        { key: KEY, prompt: 'ship the field', projects: ['demo'], attachments: [file.id] },
        { status: () => undefined },
        null,
      );
    expect(sent.key).toBe(KEY);
    await flow.app.pipeline.whenIdle(KEY);

    expect(blocks.prompts.length).toBeGreaterThan(0);
    for (const { prompt } of blocks.prompts) {
      expect(prompt).toContain(`- ${LIST}/shot.png`);
    }
    expect(mountsOf('plan')).toContain(`${LIST} (read only)`);
  });

  it('a run without files has no section in its prompts and no attachments mount', async () => {
    await remember(flow.app.app.get(RunRepository), flow.app.app.get(DocumentRepository), KEY, 'research', 'waiting');
    await flow.person('resume');

    expect(blocks.prompts.length).toBeGreaterThan(5);
    for (const { prompt, freshPrompt } of blocks.prompts) {
      expect(prompt).not.toContain('Attachments');
      expect(freshPrompt ?? '').not.toContain('Attachments');
    }
    expect(mountsOf('implement').filter((mount) => mount.startsWith(LIST))).toEqual([]);
  });
});
