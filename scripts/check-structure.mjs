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

export function findViolations({ root, rules, files }) {
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
  for (const { file, pattern: forbidden } of rules.forbidInFile ?? []) {
    const text = existsSync(join(root, file)) ? readText(join(root, file)) : null;
    const forbiddenPattern = new RegExp(forbidden);
    text?.split('\n').forEach((line, index) => {
      if (forbiddenPattern.test(line)) {
        violations.push(`${file}:${index + 1}: ${line.trim()}`);
      }
    });
  }
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
