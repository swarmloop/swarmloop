import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

export interface McpServerSpec {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

/** Write IDE MCP servers where the cursor agent loads them, and put the directory back afterwards. */
export function installMcp(directory: string, servers: McpServerSpec[]): () => void {
  const usable = servers.filter((server) => server.name && (server.command || server.url));
  if (usable.length === 0) {
    return () => undefined;
  }
  const folder = join(directory, '.cursor');
  const file = join(folder, 'mcp.json');
  const existed = existsSync(file);
  const previous = existed ? readFileSync(file, 'utf8') : '';
  mkdirSync(folder, { recursive: true });
  const current = existed ? readServers(previous) : {};
  for (const server of usable) {
    // Command and URL only. Env can hold IDE tokens, and a crash would leave them in the project.
    current[server.name] = {
      ...(server.command ? { command: server.command, args: server.args ?? [] } : {}),
      ...(server.url ? { url: server.url } : {}),
    };
  }
  writeFileSync(file, `${JSON.stringify({ mcpServers: current }, null, 2)}\n`);
  return () => {
    if (existed) {
      writeFileSync(file, previous);
      return;
    }
    rmSync(file, { force: true });
  };
}

export function readMcpServers(value: unknown): McpServerSpec[] {
  const list = Array.isArray(value) ? value : value && typeof value === 'object' && Array.isArray((value as { mcpServers?: unknown }).mcpServers) ? (value as { mcpServers: unknown[] }).mcpServers : [];
  const servers: McpServerSpec[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const row = item as { name?: unknown; command?: unknown; args?: unknown; env?: unknown; url?: unknown };
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    if (!name) {
      continue;
    }
    const args = Array.isArray(row.args) ? row.args.filter((arg): arg is string => typeof arg === 'string') : [];
    servers.push({
      name,
      command: typeof row.command === 'string' ? row.command : undefined,
      args,
      env: envRecord(row.env),
      url: typeof row.url === 'string' ? row.url : undefined,
    });
  }
  return servers;
}

function readServers(body: string): Record<string, { command?: string; args?: string[]; env?: Record<string, string>; url?: string }> {
  try {
    const parsed = JSON.parse(body) as { mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string>; url?: string }> };
    return parsed.mcpServers ?? {};
  } catch {
    return {};
  }
}

function envRecord(value: unknown): Record<string, string> {
  if (!value) {
    return {};
  }
  if (Array.isArray(value)) {
    const env: Record<string, string> = {};
    for (const item of value) {
      if (item && typeof item === 'object' && 'name' in item && 'value' in item) {
        const row = item as { name: unknown; value: unknown };
        if (typeof row.name === 'string') {
          env[row.name] = String(row.value ?? '');
        }
      }
    }
    return env;
  }
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, item]) => [name, String(item ?? '')]));
  }
  return {};
}
