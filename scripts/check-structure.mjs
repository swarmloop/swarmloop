import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');

function readText(path) {
  const bytes = readFileSync(path);
  return bytes.includes(0) ? null : bytes.toString('utf8');
}

function gitIgnores(root) {
  return (path) => {
    try {
      execFileSync('git', ['check-ignore', '-q', path], { cwd: root, stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };
}

/** A path that `AGENTS.md` names in backticks must exist in the repository or be ignored by git. */
function agentsPathViolations(root, isIgnored) {
  const file = join(root, 'AGENTS.md');
  if (!existsSync(file)) {
    return [];
  }
  const violations = [];
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, index) => {
      for (const [, token] of line.matchAll(/`([^`]+)`/g)) {
        const isPath = token.includes('/') || /\.\w+$/.test(token);
        if (isPath && !/[* ]/.test(token) && !existsSync(join(root, token)) && !isIgnored(token)) {
          violations.push(`AGENTS.md:${index + 1}: ${token}`);
        }
      }
    });
  return violations;
}

export function findViolations({ root, rules, files, isIgnored = gitIgnores(root) }) {
  const violations = [];
  for (const rel of rules.mustNotExist) {
    if (existsSync(join(root, rel))) {
      violations.push(`${rel}: must not exist`);
    }
  }

  const pattern = new RegExp(rules.forbidPattern.pattern);
  for (const rel of files) {
    if (!existsSync(join(root, rel))) {
      continue;
    }
    if (rules.forbidPattern.exclude.some((prefix) => rel.startsWith(prefix))) {
      continue;
    }
    const text = readText(join(root, rel));
    if (text === null) {
      continue;
    }
    text.split('\n').forEach((line, index) => {
      if (pattern.test(line)) {
        violations.push(`${rel}:${index + 1}: ${line.trim()}`);
      }
    });
  }
  for (const { include, exclude, allowFiles = [], allowLine, pattern: outside } of rules.forbidOutside ?? []) {
    const outsidePattern = new RegExp(outside);
    const excluded = exclude ? new RegExp(exclude) : null;
    const allowed = allowLine ? new RegExp(allowLine) : null;
    const prefixes = [include].flat();
    for (const rel of files) {
      if (
        !prefixes.some((prefix) => rel.startsWith(prefix)) ||
        allowFiles.some((prefix) => rel.startsWith(prefix)) ||
        excluded?.test(rel) ||
        !existsSync(join(root, rel))
      ) {
        continue;
      }
      readText(join(root, rel))
        ?.split('\n')
        .forEach((line, index) => {
          if (outsidePattern.test(line) && !allowed?.test(line)) {
            violations.push(`${rel}:${index + 1}: ${line.trim()}`);
          }
        });
    }
  }
  for (const { file, pattern: forbidden } of rules.forbidInFile ?? []) {
    const text = existsSync(join(root, file)) ? readText(join(root, file)) : null;
    const forbiddenPattern = new RegExp(forbidden);
    text?.split('\n').forEach((line, index) => {
      if (forbiddenPattern.test(line)) {
        violations.push(`${file}:${index + 1}: ${line.trim()}`);
      }
    });
  }
  violations.push(...agentsPathViolations(root, isIgnored));
  return violations;
}

function main() {
  const rules = JSON.parse(readFileSync(join(scriptsDir, 'structure-rules.json'), 'utf8'));
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  const violations = findViolations({ root: repoRoot, rules, files });
  for (const violation of violations) {
    console.error(violation);
  }
  if (violations.length > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
