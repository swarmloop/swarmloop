export function documentsByKind<T extends { kind: string }>(documents: readonly T[]): [string, T[]][] {
  const map = new Map<string, T[]>();
  for (const document of documents) {
    map.set(document.kind, [...(map.get(document.kind) ?? []), document]);
  }
  return [...map.entries()];
}

export function tokensByModel(
  stats: readonly { model: string | null; tokensIn: number; tokensOut: number }[],
): [string, { inn: number; out: number }][] {
  const byModel = new Map<string, { inn: number; out: number }>();
  for (const stat of stats) {
    const key = stat.model ?? 'none';
    const current = byModel.get(key) ?? { inn: 0, out: 0 };
    byModel.set(key, { inn: current.inn + stat.tokensIn, out: current.out + stat.tokensOut });
  }
  return [...byModel.entries()];
}
