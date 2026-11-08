import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TAG_PATTERN = /^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$/;

export function validateTag(tag) {
  if (!TAG_PATTERN.test(tag)) {
    throw new Error(`tag ${tag} is not a release tag: expected vMAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCH-suffix`);
  }
  return tag.slice(1);
}

export function assertOnMain(commit, { cwd }) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', commit, 'origin/main'], { cwd, stdio: 'ignore' });
  } catch {
    throw new Error(`commit ${commit} is not on main: a release tag must point at a commit on main`);
  }
}

export function classifyImage({ existingRevision, revision }) {
  if (!existingRevision) {
    return 'build';
  }
  if (existingRevision !== revision) {
    throw new Error(`image exists under this tag with revision ${existingRevision}, not ${revision}`);
  }
  return 'reuse';
}

function main([command, ...rest]) {
  if (command === 'classify') {
    const [existingRevision, revision] = rest;
    return classifyImage({ existingRevision, revision });
  }
  const [commit] = rest;
  const version = validateTag(command);
  if (commit) {
    assertOnMain(commit, { cwd: process.cwd() });
  }
  return version;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log(main(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
