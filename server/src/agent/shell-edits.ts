const SCRIPT_EDIT = /(^|[\s;&|(])(python3?\s+-(\s|$)|sed\s+(-[a-zA-Z]*i|--in-place))/;

/** The Bash tool calls of a Claude stream that change files through the shell: a `python3 -` script or `sed -i`. */
export function countShellEdits(output: string | undefined): number {
  let count = 0;
  for (const line of (output ?? '').split('\n')) {
    if (!line.startsWith('{') || !line.includes('"Bash"')) {
      continue;
    }
    try {
      const { message } = JSON.parse(line) as { message?: { content?: unknown } };
      const parts = Array.isArray(message?.content) ? (message.content as unknown[]) : [];
      count += parts.filter((part) => {
        const { name, input } = (part ?? {}) as { name?: unknown; input?: { command?: unknown } };
        return name === 'Bash' && typeof input?.command === 'string' && SCRIPT_EDIT.test(input.command);
      }).length;
    } catch {
      continue;
    }
  }
  return count;
}
