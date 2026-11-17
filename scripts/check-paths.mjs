import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The `paths` entries of `.swarmloop.json` that match no file of the repository, tracked or not yet tracked, as
 * `<check name>: <entry>`. A renamed file would otherwise turn the check that lists it off without a word.
 */
export function unmatchedPaths(root) {
  const config = JSON.parse(readFileSync(join(root, '.swarmloop.json'), 'utf8'));
  const missing = [];
  for (const check of config.checks ?? []) {
    for (const entry of check.paths ?? []) {
      const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', entry], {
        cwd: root,
        encoding: 'utf8',
      });
      if (!files.trim()) {
        missing.push(`${check.name ?? check.run}: ${entry}`);
      }
    }
  }
  return missing;
}
