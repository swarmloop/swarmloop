import 'reflect-metadata';
import { Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { StepName } from '../core/pipeline-result';
import { BranchStep } from './branch/branch.step';
import { CommitStep } from './commit/commit.step';
import { CodeReviewStep } from './code-review/code-review.step';
import { ImplementImproveStep } from './implement/implement-improve.step';
import { ImplementStep } from './implement/implement.step';
import { MergeRequestStep } from './merge-request/merge-request.step';
import { PlanImproveStep } from './plan/plan-improve.step';
import { PlanStep } from './plan/plan.step';
import { PipelineStep } from './pipeline/pipeline.step';
import { PrepareStep } from './prepare/prepare.step';
import { RequirementsStep } from './requirements/requirements.step';
import { ResearchStep } from './research/research.step';
import { StepRegistry } from './step.registry';

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
});
