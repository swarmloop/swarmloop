import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { SkillCommand } from './agent';

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

function describe(body: string, name: string): string {
  const line = body
    .split('\n')
    .map((item) => item.trim())
    .find((item) => item.length > 0);
  return (line ?? name).replace(/^#+\s*/, '').slice(0, 120);
}
