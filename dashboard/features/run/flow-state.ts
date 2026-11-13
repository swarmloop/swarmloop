import type { FlowView } from '@contract/api';
import type { LiveLog } from '@contract/live';
import { reviewChipStatus } from '@contract/readable-log';
import { visitStored } from '../../lib/elapsed';
import { keepOpenReviews, markReviewFinished, markReviewLive, reviewChipName } from './phases';

export interface FlowMemory {
  pinnedAt: string | null;
  heldMs: number;
  heldStart: string | null;
  openReviews: readonly string[];
}

interface FlowResult {
  flow: FlowView | null;
  memory: FlowMemory;
}

export function applyFlow(current: FlowView | null, body: FlowView, memory: FlowMemory): FlowResult {
  if (
    memory.pinnedAt &&
    body.updatedAt === memory.pinnedAt &&
    current?.status === 'running' &&
    body.status === 'waiting'
  ) {
    return { flow: current, memory };
  }
  const next = { ...memory, pinnedAt: null };
  if (next.heldMs > 0 && visitStored(body.metrics.closedStarts, next.heldStart)) {
    next.heldMs = 0;
    next.heldStart = null;
  }
  const openReviews = new Set(memory.openReviews);
  if (body.status !== 'running' || body.currentStep !== 'code-review') {
    openReviews.clear();
  }
  const phases = keepOpenReviews(body.phases, openReviews);
  for (const phase of phases) {
    for (const step of phase.steps) {
      if (step.status === 'done' || step.status === 'waiting' || step.status === 'returned') {
        openReviews.delete(step.name);
      }
    }
  }
  return { flow: { ...body, phases }, memory: { ...next, openReviews: [...openReviews] } };
}

export function applyReviewLog(current: FlowView | null, memory: FlowMemory, entry: LiveLog): FlowResult {
  const chip = reviewChipName(entry.step);
  const status = reviewChipStatus(entry.body);
  const trimmed = entry.body.trim();
  const live = trimmed !== '' && trimmed !== 'waiting for output' && trimmed !== 'starting';
  const openReviews = new Set(memory.openReviews);
  if (status) {
    openReviews.delete(chip);
  } else if (live) {
    openReviews.add(chip);
  }
  const next = { ...memory, openReviews };
  if (!current) {
    return { flow: current, memory: { ...next, openReviews: [...openReviews] } };
  }
  if (status) {
    return {
      flow: { ...current, phases: markReviewFinished(current.phases, chip, status) },
      memory: { ...next, openReviews: [...openReviews] },
    };
  }
  if (current.status !== 'running' || current.currentStep !== 'code-review' || !live) {
    return { flow: current, memory: { ...next, openReviews: [...openReviews] } };
  }
  return {
    flow: { ...current, phases: markReviewLive(current.phases, chip) },
    memory: { ...next, openReviews: [...openReviews] },
  };
}
