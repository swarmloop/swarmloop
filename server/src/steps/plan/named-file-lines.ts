import { readFileSync, statSync } from 'fs';
import { isAbsolute, join } from 'path';
import type { SandboxMount } from '../../core/sandbox-mount';

const SEPARATORS = /[\s\\`'"<>()[\]{},;]+/;
const TRAILING_PUNCTUATION = /[.:!?]+$/;

type Section = { heading: string; body: string };

/** The sections, plus the files the task text names that exist in a mount with their line counts. Knows no language. */
export function withNamedFileLines(sections: Section[], text: string, mounts: SandboxMount[]): Section[] {
  const named = namedFileLines(text, mounts);
  return named ? [...sections, named] : sections;
}

function namedFileLines(text: string, mounts: SandboxMount[]): Section | null {
  const paths = new Set(text.split(SEPARATORS).map((word) => word.replace(TRAILING_PUNCTUATION, '')));
  const lines: string[] = [];
  for (const path of paths) {
    if (!path || isAbsolute(path) || path.split('/').includes('..')) {
      continue;
    }
    const count = linesOf(path, mounts);
    if (count !== null) {
      lines.push(`${path}: ${count} lines`);
    }
  }
  return lines.length > 0 ? { heading: 'Named files and their current size', body: lines.join('\n') } : null;
}

function linesOf(path: string, mounts: SandboxMount[]): number | null {
  for (const mount of mounts) {
    try {
      const file = join(mount.hostPath, path);
      if (statSync(file).isFile()) {
        const content = readFileSync(file, 'utf8');
        return content === '' ? 0 : content.replace(/\n$/, '').split('\n').length;
      }
    } catch {
      continue;
    }
  }
  return null;
}
