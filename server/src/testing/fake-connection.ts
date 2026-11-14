import type { ConnectionFlow } from '../contract/connections';
import type { Connection, ConnectionTestResult } from '../integrations/connection';
import { envFields } from '../integrations/env-fields';

interface FakeConnectionOptions {
  id: string;
  /** The names of the fields the connection asks for; all of them are secrets. */
  fields: string[];
  /** The env name that holds the server default, if any. */
  envName?: string;
  /** What `test` answers. */
  result?: ConnectionTestResult;
}

/** A `Connection` for specs: a secret flow over the given fields and a test with a chosen answer. */
export function fakeConnection(options: FakeConnectionOptions): Connection {
  const { id, fields, envName, result = { ok: true, account: null } } = options;
  const flow: ConnectionFlow = {
    kind: 'secret',
    label: `Paste ${id} key`,
    fields: fields.map((name) => ({ name, label: name, secret: true })),
    helpUrl: null,
  };
  return {
    id,
    logo: id,
    label: id,
    purpose: `Fake ${id}`,
    flows: () => [flow],
    envDefault: (env) => (envName === undefined ? null : envFields(env, [envName])),
    secrets: (values) => fields.map((name) => values[name]).filter((value) => Boolean(value)),
    test: () => Promise.resolve(result),
  };
}
