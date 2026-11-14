import { repositoryDatabase } from './repository.spec-helpers';
import { RESUME_AFTER_RESET_MS, RuntimeCooldownRepository } from './runtime-cooldown.repository';

const NOW = Date.parse('2026-11-08T18:42:00Z');
const MINUTE = 60_000;
const key = (runtime: string, credential = 'env') => ({ runtime, credential });

describe('RuntimeCooldownRepository', () => {
  it('keeps a runtime out of use until its end and the later end wins', async () => {
    const db = await repositoryDatabase();
    try {
      const cooldowns = db.app.get(RuntimeCooldownRepository);
      await cooldowns.set(key('claude'), NOW + 180 * MINUTE, true);
      await cooldowns.set(key('claude'), NOW + 60 * MINUTE, false);
      expect([...(await cooldowns.cooling(NOW + 179 * MINUTE, [key('claude')]))]).toEqual(['claude']);
      expect((await cooldowns.cooling(NOW + 180 * MINUTE, [key('claude')])).size).toBe(0);
      expect(await cooldowns.earliest([key('claude')])).toEqual({
        until: NOW + 180 * MINUTE,
        resumeAt: NOW + 180 * MINUTE + RESUME_AFTER_RESET_MS,
      });
    } finally {
      await db.close();
    }
  });

  it('resumes at the earliest end, a minute after a named reset and at the end of a default cooldown', async () => {
    const db = await repositoryDatabase();
    try {
      const cooldowns = db.app.get(RuntimeCooldownRepository);
      await cooldowns.set(key('claude'), NOW + 60 * MINUTE, true);
      await cooldowns.set(key('codex'), NOW + 90 * MINUTE, false);
      expect((await cooldowns.earliest([key('claude'), key('codex')])).resumeAt).toBe(NOW + 61 * MINUTE);
      expect((await cooldowns.earliest([key('codex')])).resumeAt).toBe(NOW + 90 * MINUTE);
      expect((await cooldowns.earliest([key('claude'), key('cursor')])).resumeAt).toBe(0);
    } finally {
      await db.close();
    }
  });

  it('keeps the credentials of one runtime apart', async () => {
    const db = await repositoryDatabase();
    try {
      const cooldowns = db.app.get(RuntimeCooldownRepository);
      await cooldowns.set(key('claude', 'ann'), NOW + 60 * MINUTE, false);
      expect([...(await cooldowns.cooling(NOW, [key('claude', 'ann')]))]).toEqual(['claude']);
      expect((await cooldowns.cooling(NOW, [key('claude'), key('claude', 'bob')])).size).toBe(0);
      expect((await cooldowns.earliest([key('claude', 'ann')])).resumeAt).toBe(NOW + 60 * MINUTE);
      expect((await cooldowns.earliest([key('claude', 'bob')])).resumeAt).toBe(0);
    } finally {
      await db.close();
    }
  });
});
