export function parseDockerStats(raw: string): { cpuPercent: number; rssBytes: number } {
  const cpu = /^([\d.]+)%/.exec(raw.trim());
  const memory = /([\d.]+)\s*([KMGT]?i?B)/i.exec(raw);
  return {
    cpuPercent: cpu ? Number(cpu[1]) : 0,
    rssBytes: memory ? memoryBytes(Number(memory[1]), memory[2] ?? 'B') : 0,
  };
}

function memoryBytes(value: number, unit: string): number {
  const scale: Record<string, number> = {
    B: 1,
    KB: 1_000,
    KiB: 1_024,
    MB: 1_000_000,
    MiB: 1_024 * 1_024,
    GB: 1_000_000_000,
    GiB: 1_024 * 1_024 * 1_024,
    TB: 1_000_000_000_000,
    TiB: 1_024 * 1_024 * 1_024 * 1_024,
  };
  return Math.round(value * (scale[unit] ?? 1));
}
