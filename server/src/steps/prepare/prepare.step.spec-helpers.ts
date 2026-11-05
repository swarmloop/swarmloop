import 'reflect-metadata';

import { execFileSync } from 'child_process';

import type { TestingModule } from '@nestjs/testing';

import { Test } from '@nestjs/testing';

import { getRepositoryToken } from '@nestjs/typeorm';

import { writeFileSync } from 'fs';

import { writeFile } from 'fs/promises';

import { join } from 'path';

import type { Repository } from 'typeorm';

import { SwarmloopConfigModule } from '../../config/config.module';

import { DocumentEntity } from '../../history/entities';

import { RunRepository } from '../../history/run.repository';

import { AGENT_RUNNER } from '../../agent/agent-runner';

import { PipelineModule } from '../../pipeline/pipeline.module';

import { PASTE_READER } from '../../integrations/linked-pages/paste-page.reader';

export async function boot(
  root: string,
  checkoutsRoot?: string,
  bases: { gitlab?: string; github?: string; gitlabToken?: string; githubToken?: string } = {},
): Promise<TestingModule> {
  await writeFile(
    join(root, '.env'),
    [
      'RUNTIME=cursor',
      'REQUIREMENTS_VIA=direct',
      'ISSUE_TRACKER=jira',
      'JIRA_BASE_URL=http://127.0.0.1:9',
      'JIRA_EMAIL=dev@example.com',
      'JIRA_API_TOKEN=token',
      `GITLAB_BASE_URL=${bases.gitlab ?? ''}`,
      `GITLAB_TOKEN=${bases.gitlabToken ?? ''}`,
      `GITHUB_BASE_URL=${bases.github ?? ''}`,
      `GITHUB_TOKEN=${bases.githubToken ?? ''}`,
      'CURSOR_API_KEY=',
      'ANTHROPIC_API_KEY=',
      'MAX_AGENT_CALLS=20',
      'MAX_RETURNS=3',
      'MAX_LAUNCHES=3',
      'MAX_RUN_USD=25',
      'IDLE_TIMEOUT_MS=900000',
      'TICK_MS=15000',
      'REQUIREMENTS_TIMEOUT_MS=600000',
      'RESEARCH_TIMEOUT_MS=900000',
      'PLAN_TIMEOUT_MS=1200000',
      'IMPLEMENT_TIMEOUT_MS=1800000',
      'CODE_REVIEW_TIMEOUT_MS=900000',
      'MERGE_REQUEST_TIMEOUT_MS=600000',
      'PIPELINE_TIMEOUT_MS=1800000',
      'PIPELINE_START_TIMEOUT_MS=180000',
      'MODEL_RESEARCH=grok-4.7',
      'MODEL_PLAN=opus-5.5-extra-high',
      'MODEL_IMPLEMENT=grok-4.7',
      'SWARMLOOP_API_PORT=3920',
      'SWARMLOOP_API_HOST=127.0.0.1',
      `SWARMLOOP_ROOT=${root}`,
      checkoutsRoot === undefined ? '' : `CHECKOUTS_ROOT=${checkoutsRoot}`,
      '',
    ].join('\n'),
  );
  return Test.createTestingModule({
    imports: [SwarmloopConfigModule.forRoot(join(root, '.env')), PipelineModule],
  })
    .overrideProvider(PASTE_READER)
    .useValue({ read: jest.fn() })
    .overrideProvider(AGENT_RUNNER)
    .useValue({ run: jest.fn() })
    .compile();
}

export async function seedRequirements(app: TestingModule, key: string): Promise<void> {
  const runs = app.get(RunRepository);
  const seeded = await runs.begin(key, 'requirements');
  seeded.status = 'waiting';
  await runs.saveRun(seeded);
  const documents = app.get<Repository<DocumentEntity>>(getRepositoryToken(DocumentEntity));
  await documents.save(
    documents.create({
      runId: seeded.id,
      stepStatId: 0,
      kind: 'requirements',
      attempt: 1,
      body: '{}\n',
      path: '',
      createdAt: new Date().toISOString(),
    }),
  );
}

export function repoWithMain(root: string, dirName: string): string {
  return publish(root, dirName, 'main');
}

export function repoWithMaster(root: string, dirName: string): string {
  return publish(root, dirName, 'master');
}

export function publish(root: string, dirName: string, branch: string): string {
  const clone = join(root, dirName);
  const remote = join(root, `${dirName}.git`);
  git(root, ['init', '-b', branch, clone]);
  commitFile(clone, 'README', `${dirName}\n`, dirName);
  git(root, ['init', '--bare', remote]);
  git(remote, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
  git(clone, ['remote', 'add', 'origin', remote]);
  git(clone, ['push', '-u', 'origin', branch]);
  return clone;
}

export function repoWithBranch(root: string, dirName: string): string {
  const clone = publish(root, dirName, 'main');
  git(clone, ['checkout', '-b', 'feature/other']);
  commitFile(clone, 'NEXT', 'other\n', 'other');
  git(clone, ['push', '-u', 'origin', 'feature/other']);
  git(clone, ['checkout', '-b', 'dirty']);
  writeFileSync(join(clone, 'local.txt'), 'noise\n');
  return clone;
}

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function hostFetch(rewrites: [string, string][]): () => void {
  const entries: [string, string][] = [['protocol.file.allow', 'always'], ...rewrites];
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
  const previousSsh = process.env.GIT_SSH_COMMAND;
  process.env.GIT_SSH_COMMAND = 'false';
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
    if (previousSsh === undefined) {
      delete process.env.GIT_SSH_COMMAND;
    } else {
      process.env.GIT_SSH_COMMAND = previousSsh;
    }
  };
}

export function commitFile(cwd: string, name: string, body: string, message: string): void {
  writeFileSync(join(cwd, name), body);
  execFileSync('git', ['add', name], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['-c', 'user.email=dev@example.com', '-c', 'user.name=Dev', 'commit', '-m', message], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
