import 'reflect-metadata';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { AppConfig } from '../config/env';
import { claudeDisallowedTools } from '../integrations/agent-runtime/claude/claude.runtime';
import { expectGolden } from '../testing/step-trace.spec-helpers';
import { boot } from './prepare/prepare.step.spec-helpers';
import { StepRegistry } from './step.registry';
import type { AgentTools } from '../integrations/agent-runtime/agent-runtime';

// Beside the spec: the trace goldens in `testing/golden` all hold step traces, and this one holds a table.
const GOLDEN_DIR = join(__dirname, 'golden');

/**
 * The tools each launch is denied on Claude, so a change to a step's tools shows in review.
 * The repo does not list Claude's full tool set, so the record counts denied tools, not allowed ones.
 */
describe('agent tools per step', () => {
  it('records the denied tools of every launch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-agent-tools-'));
    const app = await boot(root);
    try {
      const described = app.get(StepRegistry).describe(app.get(AppConfig).env);
      const profileTools = (name: string): AgentTools => {
        const tools = described.find((item) => item.name === name)?.agent?.tools;
        if (!tools) {
          throw new Error(`${name} has no tools profile`);
        }
        return tools;
      };
      // Reviewers and the report launch outside the step profile; rebase resolution runs through implement, chat has its own.
      const launches: [string, AgentTools][] = [
        ['research', profileTools('research')],
        ['plan', profileTools('plan')],
        ['plan-improve', profileTools('plan-improve')],
        ['implement', profileTools('implement')],
        ['implement-improve', profileTools('implement-improve')],
        ['code-review-reviewer', 'read'],
        ['code-review-report', profileTools('code-review')],
        ['rebase-resolution', profileTools('implement')],
        ['chat', 'write'],
      ];
      expectGolden(
        'agent-tools',
        launches.map(([step, tools]) => {
          const denied = claudeDisallowedTools(tools).split(',');
          return { step, tools, deniedCount: denied.length, denied };
        }),
        GOLDEN_DIR,
      );
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
