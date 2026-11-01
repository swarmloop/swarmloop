import { SwarmloopError } from '../../swarmloop-error';

export function bulletSection(text: string, name: string): string {
  const block = section(text, name);
  if (block === null) {
    throw new SwarmloopError(`${name} is missing`);
  }
  const lines = items(block).filter((item) => item !== 'none');
  if (lines.length === 0) {
    throw new SwarmloopError(`${name} is empty`);
  }
  return bulletList(lines);
}

export function section(text: string, name: string): string | null {
  const lines = text.split(/\r?\n/);
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (heading(lines[index] ?? '') === `${name}:`) {
      start = index;
    }
  }
  if (start < 0) {
    return null;
  }
  const rest: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = heading(lines[index] ?? '');
    if (line.endsWith(':') && !line.startsWith('-')) {
      break;
    }
    rest.push(lines[index] ?? '');
  }
  return rest.join('\n');
}

function heading(line: string): string {
  return line.trim().replace(/^[`*]+/, '').replace(/[`*]+$/, '').trim();
}

export function bulletList(lines: string[]): string {
  if (lines.length === 0) {
    return '';
  }
  return `${lines.map((line) => `- ${line}`).join('\n')}\n`;
}

export function items(block: string): string[] {
  return block
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
    .filter((line) => line.length > 0);
}
