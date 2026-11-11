import { countShellEdits } from './shell-edits';

function bash(command: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] },
  });
}

describe('countShellEdits', () => {
  it('counts the Bash calls that rewrite files through python3 - or sed -i', () => {
    const stream = [
      bash("python3 - <<'EOF'\nopen('a.ts','w').write('x')\nEOF"),
      bash("sed -i 's/a/b/' src/a.ts"),
      bash('cd server && sed -n 1,20p src/a.ts && sed -i.bak s/a/b/ src/b.ts'),
    ].join('\n');
    expect(countShellEdits(stream)).toBe(3);
  });

  it('does not count commands, other tools or a python script file', () => {
    const edit = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Edit', input: { command: 'sed -i x' } }] },
    });
    const stream = [bash('npm test --prefix server'), bash('python3 scripts/check.py'), edit, 'not json'].join('\n');
    expect(countShellEdits(stream)).toBe(0);
    expect(countShellEdits(undefined)).toBe(0);
  });
});
