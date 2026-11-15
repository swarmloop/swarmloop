import { Test } from '@nestjs/testing';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { SwarmloopConfigModule } from '../../config/config.module';
import { writeEnvOverrides } from '../../testing/env.spec-helpers';
import { RunRepository } from '../../history/run.repository';
import { DocumentRepository } from '../../history/document.repository';
import { PipelineModule } from '../../pipeline/pipeline.module';
import { git } from '../../testing/git-fixture';
import { seedMigratedDatabase } from '../../testing/migrated-database.spec-helpers';
import { featureWorktree } from '../../testing/runs.spec-helpers';

export async function boot(root: string, codeHost = 'gitlab', host: { baseUrl?: string; token?: string } = {}) {
  await writeEnvOverrides(root, {
    REQUIREMENTS_VIA: 'direct',
    GITLAB_BASE_URL: codeHost === 'gitlab' ? (host.baseUrl ?? '') : '',
    GITLAB_TOKEN: codeHost === 'gitlab' ? (host.token ?? '') : '',
    GITHUB_BASE_URL: codeHost === 'github' ? (host.baseUrl ?? '') : '',
    GITHUB_TOKEN: codeHost === 'github' ? (host.token ?? '') : '',
    MAX_AGENT_CALLS: '20',
    MAX_RETURNS: '3',
    MAX_RUN_USD: '25',
    AGENTS_PLAN: 'cursor:opus-5.5-extra-high',
    AGENTS_IMPLEMENT: 'cursor:grok-4.7',
    AGENTS_REVIEW: 'cursor:opus-5.5-extra-high',
    SWARMLOOP_ROOT: root,
  });
  seedMigratedDatabase(root);
  const app = await Test.createTestingModule({
    imports: [SwarmloopConfigModule.forRoot(join(root, '.env')), PipelineModule],
  }).compile();
  return app;
}

export async function seed(app: Awaited<ReturnType<typeof boot>>, key: string, codeHost = ''): Promise<void> {
  const runs = app.get(RunRepository);
  const documents = app.get(DocumentRepository);
  const seeded = await runs.begin(key, 'commit');
  seeded.status = 'waiting';
  seeded.currentStep = 'code-review';
  seeded.codeHost = codeHost;
  await runs.saveRun(seeded);
  await documents.putDocument(
    seeded,
    'requirements',
    `${JSON.stringify({
      prompt: 'Ship the field\n',
      tickets: [{ key, summary: 'Ship the field', description: '', acceptanceCriteria: '', comments: [] }],
      epic: null,
      epics: [],
      files: [],
      pages: [],
    })}\n`,
  );
  await documents.putDocument(seeded, 'repos', 'demo\n');
}

export function featureTree(root: string, key: string): string {
  const { tree, clone } = featureWorktree(root, key);
  writeFileSync(join(clone, '.git', 'info', 'exclude'), '.env\n');
  return tree;
}

export { git };

export function hostPush(bare: string, token: string): () => void {
  const entries = [
    ['protocol.file.allow', 'always'],
    [`url.${bare}.insteadOf`, `https://oauth2:${token}@gitlab.example/group/demo.git`],
    [`url.${bare}.insteadOf`, 'https://gitlab.example/group/demo.git'],
  ];
  const start = Number(process.env.GIT_CONFIG_COUNT);
  const base = Number.isInteger(start) && start > 0 ? start : 0;
  const savedCount = process.env.GIT_CONFIG_COUNT;
  const saved = entries.map((_, index) => {
    const slot = String(base + index);
    return { slot, key: process.env[`GIT_CONFIG_KEY_${slot}`], value: process.env[`GIT_CONFIG_VALUE_${slot}`] };
  });
  entries.forEach(([key, value], index) => {
    const slot = String(base + index);
    process.env[`GIT_CONFIG_KEY_${slot}`] = key;
    process.env[`GIT_CONFIG_VALUE_${slot}`] = value;
  });
  process.env.GIT_CONFIG_COUNT = String(base + entries.length);
  return () => {
    if (savedCount === undefined) {
      delete process.env.GIT_CONFIG_COUNT;
    } else {
      process.env.GIT_CONFIG_COUNT = savedCount;
    }
    for (const item of saved) {
      if (item.key === undefined) {
        delete process.env[`GIT_CONFIG_KEY_${item.slot}`];
      } else {
        process.env[`GIT_CONFIG_KEY_${item.slot}`] = item.key;
      }
      if (item.value === undefined) {
        delete process.env[`GIT_CONFIG_VALUE_${item.slot}`];
      } else {
        process.env[`GIT_CONFIG_VALUE_${item.slot}`] = item.value;
      }
    }
  };
}
