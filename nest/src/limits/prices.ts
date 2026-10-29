import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { ModelPrice } from './limits';

const SOURCES = {
  cursor: 'https://cursor.com/docs/models-and-pricing.md',
  claude: 'https://platform.claude.com/docs/en/about-claude/pricing.md',
} as const;
const DAY_MS = 24 * 60 * 60 * 1000;

export function parsePriceMarkdown(markdown: string): Record<string, ModelPrice> {
  const prices: Record<string, ModelPrice> = {};
  let header: string[] | null = null;
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('|')) {
      header = null;
      continue;
    }
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.every((cell) => /^:?-+:?$/.test(cell))) {
      continue;
    }
    if (!header) {
      header = cells.map((cell) => cell.toLowerCase());
      continue;
    }
    const model = cell(cells, header, /^model$/);
    const input = money(cell(cells, header, /input/));
    const output = money(cell(cells, header, /output/));
    if (!model || input === null || output === null) {
      continue;
    }
    const key = slug(model);
    if (!prices[key]) {
      prices[key] = {
        inputPerMillion: input,
        outputPerMillion: output,
        cacheReadPerMillion: money(cell(cells, header, /cache read/)),
        cacheWritePerMillion: money(cell(cells, header, /cache write/)),
      };
    }
  }
  return prices;
}

export async function loadPriceTable(
  root: string,
  runtime: keyof typeof SOURCES = 'cursor',
  now = Date.now(),
  fetchPage: typeof fetch = fetch,
): Promise<Record<string, ModelPrice>> {
  const file = join(root, 'data', `price-cache-${runtime}.json`);
  const cached = await readCache(file);
  const young = cached !== null && now - Date.parse(cached.fetchedAt) < DAY_MS;
  if (cached && young && hasCacheRates(cached.prices)) {
    return cached.prices;
  }
  try {
    const response = await fetchPage(SOURCES[runtime], { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      return cached?.prices ?? {};
    }
    const prices = parsePriceMarkdown(await response.text());
    if (Object.keys(prices).length === 0) {
      return cached?.prices ?? {};
    }
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify({ fetchedAt: new Date(now).toISOString(), prices })}\n`);
    return prices;
  } catch {
    return cached?.prices ?? {};
  }
}

function hasCacheRates(prices: Record<string, ModelPrice>): boolean {
  return Object.values(prices).every((row) => 'cacheReadPerMillion' in row && 'cacheWritePerMillion' in row);
}

function cell(cells: string[], header: string[], pattern: RegExp): string | undefined {
  const index = header.findIndex((name) => pattern.test(name));
  return index < 0 ? undefined : cells[index];
}

function money(value: string | undefined): number | null {
  if (!value || value === '-') {
    return null;
  }
  const match = value.match(/(\d+(?:\.\d+)?)/);
  if (!match) {
    return null;
  }
  const amount = Number(match[1]);
  return Number.isFinite(amount) ? amount : null;
}

function slug(name: string): string {
  const fast = /\bfast\b/i.test(name);
  const base = name
    .replace(/\(.*?\)/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return fast && !base.endsWith('-fast') ? `${base}-fast` : base;
}

async function readCache(file: string): Promise<{ fetchedAt: string; prices: Record<string, ModelPrice> } | null> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { fetchedAt?: unknown; prices?: unknown };
    if (typeof parsed.fetchedAt !== 'string' || !parsed.prices || typeof parsed.prices !== 'object') {
      return null;
    }
    return { fetchedAt: parsed.fetchedAt, prices: parsed.prices as Record<string, ModelPrice> };
  } catch {
    return null;
  }
}
