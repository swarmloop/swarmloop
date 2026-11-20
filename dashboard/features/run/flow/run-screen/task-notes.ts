import type { TaskEntry } from '@contract/api';
import { interruptionSentence } from '@contract/interruption';
import type { taskStateWord } from '@contract/run-state';
import { localTime } from '../../../../lib/format';

type StateWord = ReturnType<typeof taskStateWord>;

/** The reason a failed or blocked task gives, or '' for any other task. */
function reasonOf(task: TaskEntry, word: StateWord): string {
  const needsReason = task.status === 'blocked' || word.tone === 'error';
  return needsReason ? (task.run?.stateReason?.message ?? task.note ?? '') : '';
}

function waitCaption(task: TaskEntry, unmet: string[]): string {
  if (!task.waitsFor) return '';
  return task.waitsFor.length > 0 ? `after ${unmet.join(', ')}` : 'waiting for a free slot';
}

/**
 * What a task row says besides its first line. `tip` goes into the state icon's tooltip: the state's own tip, an
 * interruption the server started again by itself, and the task's note. `caption` is the short second line, only when
 * the task waits, needs the person, or was interrupted and not started again.
 */
export function taskNotes(task: TaskEntry, word: StateWord, unmet: string[]): { tip: string; caption: string } {
  const interruption = task.run?.interruption ? interruptionSentence(task.run.interruption, localTime) : '';
  const relaunched = task.run?.interruption?.relaunched === true;
  const reason = reasonOf(task, word);
  const note = task.note && !task.waitsFor && reason === '' ? task.note : '';
  const tip = [word.tip, relaunched ? interruption : '', note].filter((part) => part !== '').join(' ');
  const caption = waitCaption(task, unmet) || reason || (relaunched ? '' : interruption);
  return { tip, caption };
}
