import { PersonalCredentials } from '../auth/personal-credentials.service';
import { SecretBox } from '../auth/secret-box';
import { AppConfig } from '../config/env';
import { testEnv } from '../config/env.spec-helpers';
import { IntegrationSecretRepository } from '../history/integration-secret.repository';
import { repositoryDatabase } from '../history/repository.spec-helpers';
import { RunRepository } from '../history/run.repository';
import { RuntimeCooldownRepository } from '../history/runtime-cooldown.repository';
import { fakeConnection } from './fake-connection';

const claude = fakeConnection({ id: 'claude', fields: ['ANTHROPIC_API_KEY'] });

/** The agents of a role, in the order a limit moves a launch along. */
const ROLE = [
  { runtime: 'claude', model: 'm-claude' },
  { runtime: 'codex', model: 'm-codex' },
];
const AGENTS = { main: { implement: ROLE }, subtask: { implement: ROLE } } as never;

/** A real database with the cooldowns, the runs and the personal credentials, where ann and bob each hold a Claude key. */
export async function credentialDatabase() {
  const db = await repositoryDatabase();
  const config = new AppConfig(testEnv({ SWARMLOOP_ROOT: db.root }));
  const credentials = new PersonalCredentials(
    db.app.get(IntegrationSecretRepository),
    new SecretBox('k'),
    db.clock,
    config,
  );
  await credentials.store(claude, 'ann', { ANTHROPIC_API_KEY: 'sk-ant-ann-4d1e8f7a2b9c' }, null);
  await credentials.store(claude, 'bob', { ANTHROPIC_API_KEY: 'sk-ant-bob-91c0a5e3d7f2' }, null);
  const runs = db.app.get(RunRepository);
  return {
    db,
    config,
    credentials,
    runs,
    cooldowns: db.app.get(RuntimeCooldownRepository),
    /** A run started by `startedBy`, a subtask of `parentId` when given. */
    run: (key: string, startedBy: string | null, parentId?: number) =>
      parentId === undefined
        ? runs.saveRun(runs.newWaitingRun(key, null, startedBy, AGENTS))
        : runs.openSubtask(key, parentId, 'a', startedBy, AGENTS),
  };
}
