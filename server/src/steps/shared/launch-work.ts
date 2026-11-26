import { loopHint } from '../../agent/agent-session';
import type { LoopDetector } from '../../agent/loop-detector';
import type { AgentRunInput } from '../../agent/agent-runner';
import type { AgentWork } from '../../contract/readable-log';
import type { StepEventBody } from '../../contract/step-events';
import { recordStepEvent } from '../../core/step-event-scope';
import type { AgentLaunchRequest } from './agent-launch-request';
import { promptSections } from './prompt-manifest';

/**
 * Why a launch starts a new chat. A session file that exists but gave no chat belongs to another runtime.
 * `replay` is not told apart here: `PipelineService.replay` starts a run through the instructions document, and no flag reaches the launch.
 */
function newChatReason(
  resume: boolean | undefined,
  hasFile: boolean,
  removed: boolean,
): 'fresh by step policy' | 'runtime changed' | 'no stored chat' | 'chat state removed' {
  if (resume === false) {
    return 'fresh by step policy';
  }
  if (removed) {
    return 'chat state removed';
  }
  return hasFile ? 'runtime changed' : 'no stored chat';
}

/** Records what the agent did: a tool call, or its own whole text. */
export function recordWork(work: AgentWork): void {
  if (work.kind === 'message') {
    recordStepEvent({ kind: 'agent.message', text: work.text, chars: work.text.length });
    return;
  }
  const { kind: _kind, ...tool } = work;
  recordStepEvent({ kind: 'agent.tool', ...tool });
}

/** Feeds the tool work of a launch to the loop detector and records what it finds. */
export function loopWatch(
  detector: LoopDetector,
  ending?: string,
): NonNullable<AgentRunInput['loop']> & { note(work: AgentWork): void } {
  let repeated = { command: '', errorLine: '' };
  return {
    note(work) {
      if (work.kind !== 'tool') {
        return;
      }
      const { state, command, errorLine, count } = detector.note(work);
      if (state === 'watching') {
        return;
      }
      repeated = { command, errorLine };
      recordStepEvent({
        kind: 'agent.loop_hint',
        command,
        errorLine,
        count,
        ...(state === 'end' ? { ended: true } : {}),
      });
    },
    pending: () => detector.pending(),
    resumePrompt: () => (detector.resolveHint() ? loopHint(repeated.command, repeated.errorLine, ending) : null),
  };
}

/** An effort the runtime could not give is said once per launch: what the model supports and what ran instead. */
function recordCap(request: AgentLaunchRequest): void {
  const wanted = request.effortNote?.startsWith('capped:') ? request.effortNote.slice('capped:'.length) : null;
  if (wanted && request.effort) {
    recordStepEvent({
      kind: 'agent.effort_capped',
      model: request.model,
      level: request.effort,
      wanted,
      text: `${request.model} supports up to ${request.effort}; ran at ${request.effort} instead of ${wanted}.`,
    });
  }
}

/** The events of a launch that starts: its chat, why a new one, the context it gets, and the agent that launches. */
export function recordStart(
  request: AgentLaunchRequest,
  launch: Omit<Extract<StepEventBody, { kind: 'agent.launched' }>, 'kind'>,
  sessionStored: boolean,
  removed: boolean,
): void {
  recordStepEvent({
    kind: 'session.changed',
    session: launch.chatId === null ? 'new chat' : 'same chat',
    runtime: launch.runtime,
    model: launch.model,
    reason: launch.chatId !== null ? null : newChatReason(request.resume, sessionStored, removed),
  });
  recordCap(request);
  recordStepEvent({
    kind: 'context.manifest',
    sections: promptSections(request.prompt),
    artifacts: request.mounts.map((mount) => mount.containerPath),
    cut: [],
  });
  recordStepEvent({ kind: 'agent.launched', ...launch });
}
