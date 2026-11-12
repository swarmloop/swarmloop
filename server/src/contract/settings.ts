import type { SettingsBody } from './api';

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
