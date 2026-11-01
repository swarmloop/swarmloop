import { SwarmloopError } from '../../swarmloop-error';
import { bulletSection } from '../shared/markdown-section';

export function parseImplementation(text: string): string {
  return bulletSection(text, 'implementation');
}

const STOOD = /^the first pass stands\.?$/i;

/** Notes the review returned. Empty when the review left the first pass as it was. */
export function reviewedImplementation(text: string): string {
  try {
    const body = parseImplementation(text);
    const lines = body
      .split('\n')
      .map((line) => line.replace(/^- /, '').trim())
      .filter((line) => line.length > 0);
    if (lines.length === 1 && STOOD.test(lines[0] ?? '')) {
      return '';
    }
    return body;
  } catch (error) {
    if (error instanceof SwarmloopError && (error.message === 'implementation is missing' || error.message === 'implementation is empty')) {
      return '';
    }
    throw error;
  }
}

export function joinRepoNotes(parts: { name: string; body: string }[]): string {
  if (parts.length === 1) {
    return parts[0]?.body ?? '';
  }
  return `${parts.map((part) => `${part.name}:\n${part.body.trimEnd()}`).join('\n\n')}\n`;
}

export function withReturnNotes(
  sections: { heading: string; body: string }[],
  returned: string | null,
): { heading: string; body: string }[] {
  return returned?.trim() ? [...sections, { heading: 'Why this returned', body: returned }] : sections;
}
