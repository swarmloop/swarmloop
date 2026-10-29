export interface PlannedPath {
  repo: string;
  path: string;
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

export function porcelainPaths(text: string): string[] {
  const parts = text.split('\0');
  const paths: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index] ?? '';
    if (entry.length < 4) {
      continue;
    }
    const path = entry.slice(3);
    if (!path) {
      continue;
    }
    paths.push(path);
    if (entry.slice(0, 2).includes('R') || entry.slice(0, 2).includes('C')) {
      index += 1;
    }
  }
  return paths;
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
