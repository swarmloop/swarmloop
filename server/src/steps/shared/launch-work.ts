import { loopHint } from '../../agent/agent-session';
import type { LoopDetector } from '../../agent/loop-detector';
import type { AgentRunInput } from '../../agent/agent-runner';
import type { AgentWork } from '../../contract/readable-log';
import { recordStepEvent } from '../../core/step-event-scope';

/**
 * Why a launch starts a new chat. A session file that exists but gave no chat belongs to another runtime.
 * `replay` is not told apart here: `PipelineService.replay` starts a run through the instructions document, and no flag reaches the launch.
 */
export function newChatReason(
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

const MESSAGE_CHARS = 600;

/** Records what the agent did: a tool call, or its own text cut to 600 characters. */
export function recordWork(work: AgentWork): void {
  if (work.kind === 'message') {
    recordStepEvent({ kind: 'agent.message', text: work.text.slice(0, MESSAGE_CHARS), chars: work.text.length });
    return;
  }
  const { kind: _kind, ...tool } = work;
  recordStepEvent({ kind: 'agent.tool', ...tool });
}

/** Feeds the tool work of a launch to the loop detector and records what it finds. */
export function loopWatch(
  detector: LoopDetector,
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
    resumePrompt: () => (detector.resolveHint() ? loopHint(repeated.command, repeated.errorLine) : null),
  };
}
