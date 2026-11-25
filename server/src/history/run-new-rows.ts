import type { StoredAgents } from '../contract/api';
import { agentFor } from '../config/agents';
import type { AppConfig } from '../config/env';
import type { Clock } from '../core/clock';
import type { RunEntity } from './entities';
import { claimedColumns, stateColumns } from './run-state';

type NewRun = (row: Partial<RunEntity>) => RunEntity;

/** A waiting run row that is not stored yet. */
export function waitingRow(
  create: NewRun,
  config: AppConfig,
  clock: Clock,
  key: string,
  targetPath: string | null,
  startedBy: string | null,
  agents: StoredAgents | null,
): RunEntity {
  const now = clock.iso();
  return create({
    key,
    ...stateColumns({ currentStep: 'requirements', ownerInstance: null, activeAttempt: null }, { status: 'waiting' }),
    runtime: agentFor(config.env, { agents }, 'implement').runtime,
    codeHost: '',
    attemptsReview: 0,
    attemptsPipeline: 0,
    attemptsChecks: 0,
    agentCalls: 0,
    spentUsd: 0,
    agents,
    targetPath,
    projects: null,
    prompt: null,
    createdAt: now,
    updatedAt: now,
    stepStartedAt: null,
    parentRunId: null,
    taskId: null,
    split: false,
    startedBy,
  });
}

/** A run row that a first step claims as it is made, not stored yet. */
export function claimedRow(
  create: NewRun,
  config: AppConfig,
  clock: Clock,
  key: string,
  step: string,
  attemptId: string,
): RunEntity {
  const now = clock.iso();
  return create({
    key,
    ...claimedColumns(step, attemptId),
    runtime: agentFor(config.env, null, 'implement').runtime,
    codeHost: '',
    attemptsReview: 0,
    attemptsPipeline: 0,
    attemptsChecks: 0,
    agentCalls: 0,
    spentUsd: 0,
    targetPath: null,
    projects: null,
    revision: 0,
    generation: 0,
    prompt: null,
    createdAt: now,
    updatedAt: now,
    stepStartedAt: now,
  });
}
