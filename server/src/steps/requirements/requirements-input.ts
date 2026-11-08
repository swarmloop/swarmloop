import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import type { StepOptions } from '../../core/pipeline-result';
import { SwarmloopError } from '../../core/swarmloop-error';

export async function readPrompt(options: StepOptions): Promise<string | undefined> {
  if (options.prompt !== undefined && options.promptFile !== undefined) {
    throw new SwarmloopError('prompt and prompt-file are both set');
  }
  if (options.prompt === undefined && options.promptFile === undefined) {
    return undefined;
  }
  const text = options.promptFile !== undefined ? await readPromptFile(options.promptFile) : (options.prompt ?? '');
  if (!text.trim()) {
    throw new SwarmloopError('prompt is empty');
  }
  return text.endsWith('\n') ? text : `${text}\n`;
}

async function readPromptFile(path: string): Promise<string> {
  if (!existsSync(path)) {
    throw new SwarmloopError('prompt file is missing');
  }
  return readFile(path, 'utf8');
}

export function unreadSource(prompt: string): string | null {
  if (/https?:\/\/\S*slack\.com/i.test(prompt)) {
    return 'slack is not readable';
  }
  if (/https?:\/\/\S*teams\.microsoft\.com/i.test(prompt)) {
    return 'teams is not readable';
  }
  return null;
}
