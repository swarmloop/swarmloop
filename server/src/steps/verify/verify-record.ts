import { createHash } from 'crypto';

export interface VerifyRecord {
  result: 'pass' | 'fail';
  /** `snapshotId` of the worktree the checks ran on, after install. */
  snapshot: string;
  commands: string[];
  exitCode: number | null;
  tail: string;
}

export function snapshotId(snapshot: string): string {
  return createHash('sha256').update(snapshot).digest('hex');
}

/** The `verify_log` document. A failed run ends with the tail of the failing command. */
export function renderVerifyLog(record: VerifyRecord, durationMs: number): string {
  const lines = [
    `result: ${record.result}`,
    `snapshot: ${record.snapshot}`,
    `duration: ${Math.round(durationMs / 1000)}s`,
    ...record.commands.map((command) => `command: ${command}`),
  ];
  if (record.result === 'fail') {
    lines.push(`exit: ${record.exitCode ?? ''}`, 'tail:', record.tail.trimEnd());
  }
  return `${lines.join('\n')}\n`;
}

export function parseVerifyLog(body: string): VerifyRecord | null {
  const failed = /^([\s\S]*?)\nexit: ([^\n]*)\ntail:\n([\s\S]*)$/.exec(body);
  const lines = (failed?.[1] ?? body).split('\n');
  const field = (name: string): string | undefined =>
    lines
      .find((line) => line.startsWith(`${name}: `))
      ?.slice(name.length + 2)
      .trim();
  const result = field('result');
  const snapshot = field('snapshot');
  if ((result !== 'pass' && result !== 'fail') || !snapshot) {
    return null;
  }
  return {
    result,
    snapshot,
    commands: lines.filter((line) => line.startsWith('command: ')).map((line) => line.slice('command: '.length)),
    exitCode: failed?.[2]?.trim() ? Number(failed[2]) : null,
    tail: failed?.[3]?.trimEnd() ?? '',
  };
}

export function latestVerifyLog(documents: { kind: string; body: string }[]): VerifyRecord | null {
  const found = [...documents].reverse().find((item) => item.kind === 'verify_log');
  return found ? parseVerifyLog(found.body) : null;
}

/** The line that tells reviewers what a machine already proved on the tree they review. */
export function machineLine(commands: string[]): string {
  return `Checked by machine on this exact tree: ${commands.join(', ')}. Do not re-check what these cover; look for what they cannot find.`;
}
