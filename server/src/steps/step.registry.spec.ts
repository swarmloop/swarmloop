import 'reflect-metadata';
import type { Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { SwarmloopEnv } from '../config/env';
import type { StepName } from '../contract/steps';
import { BranchStep } from './branch/branch.step';
import { CommitStep } from './commit/commit.step';
import { CodeReviewStep } from './code-review/code-review.step';
import { ImplementImproveStep } from './implement/implement-improve.step';
import { ImplementStep } from './implement/implement.step';
import { MergeRequestStep } from './merge-request/merge-request.step';
import { PlanImproveStep } from './plan-improve/plan-improve.step';
import { PlanStep } from './plan/plan.step';
import { PipelineStep } from './pipeline/pipeline.step';
import { PrepareStep } from './prepare/prepare.step';
import { RequirementsStep } from './requirements/requirements.step';
import { ResearchStep } from './research/research.step';
import { ARTIFACTS } from './contract/artifacts';
import { boot } from './prepare/prepare.step.spec-helpers';
import { StepRegistry } from './step.registry';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const SERVICES: [Type<unknown>, Exclude<StepName, 'done'>][] = [
  [RequirementsStep, 'requirements'],
  [PrepareStep, 'prepare'],
  [ResearchStep, 'research'],
  [BranchStep, 'branch'],
  [PlanStep, 'plan'],
  [PlanImproveStep, 'plan-improve'],
  [ImplementStep, 'implement'],
  [ImplementImproveStep, 'implement-improve'],
  [CodeReviewStep, 'code-review'],
  [CommitStep, 'commit'],
  [MergeRequestStep, 'merge-request'],
  [PipelineStep, 'pipeline'],
];

describe('step registry', () => {
  it('returns the step for each of the twelve names and none for done', async () => {
    const app = await Test.createTestingModule({
      providers: [StepRegistry, ...SERVICES.map(([token, name]) => ({ provide: token, useValue: { name } }))],
    }).compile();
    try {
      const registry = app.get(StepRegistry);
      for (const [, name] of SERVICES) {
        expect(registry.get(name)?.name).toBe(name);
      }
      expect(registry.get('done')).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('describes every registered step once', async () => {
    const app = await Test.createTestingModule({
      providers: [
        StepRegistry,
        ...SERVICES.map(([token, name]) => ({ provide: token, useValue: { name, describe: () => ({ name }) } })),
      ],
    }).compile();
    try {
      const descriptors = app.get(StepRegistry).describe({} as SwarmloopEnv);
      expect(descriptors.map((descriptor) => descriptor.name)).toEqual(SERVICES.map(([, name]) => name));
    } finally {
      await app.close();
    }
  });

  it('has each artifact written by exactly the steps that list it in outputs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-registry-writers-'));
    const app = await boot(root);
    try {
      const described = app.get(StepRegistry).describe({} as SwarmloopEnv);
      expect(described.map((descriptor) => descriptor.name)).toEqual(SERVICES.map(([, name]) => name));
      for (const entry of Object.values(ARTIFACTS)) {
        const listing = described.filter((descriptor) => descriptor.outputs.includes(entry.kind));
        expect([entry.kind, listing.map((descriptor) => descriptor.name).sort()]).toEqual([
          entry.kind,
          [...entry.writers].sort(),
        ]);
      }
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
