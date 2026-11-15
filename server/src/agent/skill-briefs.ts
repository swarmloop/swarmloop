import { chmodSync, copyFileSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';

/** The skills folder that skill-prompt.ts reads: the repository's `skills/` in dev and test, `/app/skills` in the image. */
export const SKILLS_DIR = join(__dirname, '../../../skills');

/** Copies every skill file except SKILL.md to `<briefsDir>/skills/<relative path>`, over any earlier copy. */
export function copySkillBriefs(skillsDir: string, briefsDir: string): void {
  copyTree(skillsDir, join(briefsDir, 'skills'));
}

function copyTree(source: string, target: string): void {
  mkdirSync(target, { recursive: true });
  chmodSync(target, 0o755);
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) {
      copyTree(from, to);
    } else if (entry.name !== 'SKILL.md') {
      copyFileSync(from, to);
      chmodSync(to, 0o644);
    }
  }
}
