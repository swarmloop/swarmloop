import Database from 'better-sqlite3';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * A resumed chat keeps the mode stored on the last turn. The CLI --mode flag
 * only accepts plan and ask, so an editing step cannot switch out of plan
 * with a flag, and a later plan step cannot rely on the flag alone once the
 * store says default. Write the mode this step needs before launch.
 * Ask is stored as "search". The editing agent is stored as "default".
 */
export function syncChatMode(statePath: string, chatId: string, mode: string | undefined): void {
  const dbPath = chatStore(statePath, chatId);
  if (!dbPath) {
    return;
  }
  const wanted = storedMode(mode);
  const db = new Database(dbPath);
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('0') as { value: string } | undefined;
    if (!row?.value || row.value.length % 2 !== 0) {
      return;
    }
    const meta = JSON.parse(Buffer.from(row.value, 'hex').toString('utf8')) as { mode?: string };
    if (meta.mode === wanted) {
      return;
    }
    meta.mode = wanted;
    const next = Buffer.from(JSON.stringify(meta), 'utf8').toString('hex');
    db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(next, '0');
  } finally {
    db.close();
  }
}

function storedMode(mode: string | undefined): string {
  if (mode === 'plan') {
    return 'plan';
  }
  if (mode === 'ask') {
    return 'search';
  }
  return 'default';
}

function chatStore(statePath: string, chatId: string): string | null {
  if (chatId.includes('/') || chatId.includes('\\') || chatId === '..' || chatId === '.') {
    return null;
  }
  const root = join(statePath, '.cursor', 'chats');
  if (!existsSync(root)) {
    return null;
  }
  for (const hash of readdirSync(root)) {
    const db = join(root, hash, chatId, 'store.db');
    if (existsSync(db)) {
      return db;
    }
  }
  return null;
}
