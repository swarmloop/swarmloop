export interface PlannedPath {
  repo: string;
  path: string;
}

/** `add` is what `git add` may see. `staged` is an allowed change already in the index, including a staged deletion. */
export interface StageSelection {
  add: string[];
  staged: string[];
}

export function allowedPaths(repo: string, porcelain: string, denied: string[]): PlannedPath[] {
  return porcelainPaths(porcelain)
    .filter((path) => !isDenied(path, denied))
    .map((path) => ({ repo, path }));
}

export function isDenied(path: string, patterns: string[]): boolean {
  const normalized = path.replace(/\\/g, '/');
  return patterns.some((pattern) => {
    const needle = pattern.trim().replace(/\\/g, '/').replace(/^\.\//, '');
    if (!needle) {
      return false;
    }
    return normalized === needle || normalized.endsWith(`/${needle}`) || normalized.startsWith(`${needle}/`);
  });
}

interface PorcelainChange {
  index: string;
  path: string;
}

function porcelainChanges(text: string): PorcelainChange[] {
  const parts = text.split('\0');
  const changes: PorcelainChange[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index] ?? '';
    if (entry.length < 4) {
      continue;
    }
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (!path) {
      continue;
    }
    if (status.includes('R') || status.includes('C')) {
      index += 1;
    }
    changes.push({ index: status[0] ?? ' ', path });
  }
  return changes;
}

export function porcelainPaths(text: string): string[] {
  return porcelainChanges(text).map((change) => change.path);
}

/** Denied paths already staged. An untracked denied path is not in the index. */
export function deniedIndexPaths(porcelain: string, denied: string[]): string[] {
  return porcelainChanges(porcelain)
    .filter((change) => change.index !== ' ' && change.index !== '?' && isDenied(change.path, denied))
    .map((change) => change.path);
}

/** One staging rule. A staged deletion stays in the index. An unstaged deletion of a tracked file is added. A rename contributes its new path only. */
export function stageSelection(porcelain: string, denied: string[]): StageSelection {
  const add: string[] = [];
  const staged: string[] = [];
  for (const change of porcelainChanges(porcelain)) {
    if (isDenied(change.path, denied)) {
      continue;
    }
    if (change.index !== ' ' && change.index !== '?') {
      staged.push(change.path);
    }
    if (change.index === 'D') {
      continue;
    }
    add.push(change.path);
  }
  return { add, staged };
}

export function renderPaths(paths: PlannedPath[]): string {
  return `${paths.map((item) => `${item.repo}\t${item.path}`).join('\n')}\n`;
}

export function parsePaths(body: string): PlannedPath[] {
  return body.split('\n').flatMap((line) => {
    const tab = line.indexOf('\t');
    if (tab <= 0) {
      return [];
    }
    const repo = line.slice(0, tab).trim();
    const path = line.slice(tab + 1).trim();
    return repo && path ? [{ repo, path }] : [];
  });
}
