import 'reflect-metadata';
import { Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { StepName } from '../pipeline/pipeline-result';
import { BranchService } from './branch/branch.service';
import { CommitService } from './commit/commit.service';
import { CodeReviewService } from './code-review/code-review.service';
import { ImplementImproveService } from './implement/implement-improve.service';
import { ImplementService } from './implement/implement.service';
import { MergeRequestService } from './merge-request/merge-request.service';
import { PlanImproveService } from './plan/plan-improve.service';
import { PlanService } from './plan/plan.service';
import { PipelineStepService } from './pipeline/pipeline-step.service';
import { PrepareService } from './prepare/prepare.service';
import { RequirementsService } from './requirements/requirements.service';
import { ResearchService } from './research/research.service';
import { StepRegistry } from './step.registry';

const SERVICES: [Type<unknown>, Exclude<StepName, 'done'>][] = [
  [RequirementsService, 'requirements'],
  [PrepareService, 'prepare'],
  [ResearchService, 'research'],
  [BranchService, 'branch'],
  [PlanService, 'plan'],
  [PlanImproveService, 'plan-improve'],
  [ImplementService, 'implement'],
  [ImplementImproveService, 'implement-improve'],
  [CodeReviewService, 'code-review'],
  [CommitService, 'commit'],
  [MergeRequestService, 'merge-request'],
  [PipelineStepService, 'pipeline'],
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
