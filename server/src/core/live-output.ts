export function liveLogFinished(body: string): boolean {
  const line = lastLogLine(body);
  return line.startsWith('{"type":"result"') || line.startsWith('process exited') || line.startsWith('process killed:');
}

function lastLogLine(body: string): string {
  const lines = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return lines.at(-1) ?? '';
}

export function logStillOpen(body: string): boolean {
  const trimmed = body.trim();
  return trimmed !== '' && trimmed !== 'waiting for output' && trimmed !== 'starting' && !liveLogFinished(body);
}
