import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { syncChatMode } from './chat-mode';

describe('syncChatMode', () => {
  it('sets a plan chat back to the editing mode', () => {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-chat-mode-'));
    const dbPath = join(root, '.cursor', 'chats', 'workspace', 'chat-1', 'store.db');
    mkdirSync(join(dbPath, '..'), { recursive: true });
    const db = new Database(dbPath);
    const stored = Buffer.from(JSON.stringify({ agentId: 'chat-1', mode: 'plan' }), 'utf8').toString('hex');
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('0', stored);
    db.close();

    syncChatMode(root, 'chat-1', 'agent');

    const read = new Database(dbPath, { readonly: true });
    const row = read.prepare('SELECT value FROM meta WHERE key = ?').get('0') as { value: string };
    read.close();
    expect(JSON.parse(Buffer.from(row.value, 'hex').toString('utf8')).mode).toBe('default');
  });

  it('puts a chat back into plan mode for a plan step', () => {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-chat-mode-plan-'));
    const dbPath = join(root, '.cursor', 'chats', 'workspace', 'chat-1', 'store.db');
    mkdirSync(join(dbPath, '..'), { recursive: true });
    const db = new Database(dbPath);
    const stored = Buffer.from(JSON.stringify({ agentId: 'chat-1', mode: 'default' }), 'utf8').toString('hex');
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('0', stored);
    db.close();

    syncChatMode(root, 'chat-1', 'plan');

    const read = new Database(dbPath, { readonly: true });
    const row = read.prepare('SELECT value FROM meta WHERE key = ?').get('0') as { value: string };
    read.close();
    expect(JSON.parse(Buffer.from(row.value, 'hex').toString('utf8')).mode).toBe('plan');
  });

  it('leaves a missing chat alone', () => {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-chat-mode-missing-'));
    expect(() => syncChatMode(root, 'missing', 'agent')).not.toThrow();
  });
});
