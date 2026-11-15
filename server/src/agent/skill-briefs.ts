import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import { dirname, join, resolve } from 'path';

/** The skills folder that skill-prompt.ts reads: the repository's `skills/` in dev and test, `/app/skills` in the image. */
export const SKILLS_DIR = join(__dirname, '../../../skills');

/** Copies every skill file except SKILL.md to `<briefsDir>/skills/<relative path>`, over any earlier copy. */
export function copySkillBriefs(skillsDir: string, briefsDir: string): void {
  copyTree(skillsDir, join(briefsDir, 'skills'), resolve(dirname(briefsDir)));
}

function copyTree(source: string, target: string, stateDir: string): void {
  assertNoSymlinks(stateDir, resolve(target));
  mkdirSync(target, { recursive: true });
  chmodSync(target, 0o755);
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) {
      copyTree(from, to, stateDir);
    } else if (entry.name !== 'SKILL.md') {
      const file = openSync(to, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW);
      try {
        writeFileSync(file, readFileSync(from));
        fchmodSync(file, 0o644);
      } finally {
        closeSync(file);
      }
    }
  }
}

/** A later launch must not follow a path planted in the agent's state directory: it checks that folder and every level below it, never the folders above. */
function assertNoSymlinks(stateDir: string, path: string): void {
  if (path !== stateDir) {
    assertNoSymlinks(stateDir, dirname(path));
  }
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error('Skill brief destination is a symbolic link');
  }
}
