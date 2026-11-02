import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { SkillCommand } from './agent';

export function loadSkills(directory: string): SkillCommand[] {
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(directory, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({
      name,
      description: describe(readFileSync(join(directory, name, 'SKILL.md'), 'utf8'), name),
    }));
}

export function readCheckoutsRoot(envFile: string): string | undefined {
  if (!existsSync(envFile)) {
    return undefined;
  }
  const line = readFileSync(envFile, 'utf8')
    .split('\n')
    .find((item) => item.startsWith('CHECKOUTS_ROOT='));
  if (!line) {
    return undefined;
  }
  const value = line.slice('CHECKOUTS_ROOT='.length).trim();
  return value.length > 0 ? value : undefined;
}

function describe(body: string, name: string): string {
  const line = body
    .split('\n')
    .map((item) => item.trim())
    .find((item) => item.length > 0);
  return (line ?? name).replace(/^#+\s*/, '').slice(0, 120);
}
