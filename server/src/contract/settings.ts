/** One runtime and model, as stored for a person and on a run. */
interface StoredAgent {
  runtime: string;
  model: string;
}

type StoredRoleLists = Partial<Record<'plan' | 'implement' | 'review', StoredAgent[]>>;

/** Ordered agent lists per tier and role. A list that is absent is the server default. */
export interface StoredAgents {
  main?: StoredRoleLists;
  subtask?: StoredRoleLists;
}

/** What a person sets for their own runs. A key that is absent is "Use server default". */
export interface SettingsBody {
  agents?: StoredAgents;
  split?: boolean;
}

export interface ServerSetting {
  name: string;
  secret: boolean;
  /** The env value, or `set` / `not set` for a secret. */
  value: string;
}

/** What `GET /settings` and `PUT /settings` answer. */
export interface SettingsView {
  /** The person's own settings; empty for the machine token and for a person with none. */
  settings: SettingsBody;
  defaults: {
    agents: Record<'main' | 'subtask', Record<'plan' | 'implement' | 'review', string[]>>;
    split: boolean;
  };
  /** The runtimes with a credential, each with the models env names for it. */
  runtimes: { runtime: string; models: string[] }[];
  server: ServerSetting[];
}
