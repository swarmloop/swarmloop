import type { SettingSource } from '../contract/settings';

/** Provenance belongs to one module boot and cannot change with later loads. */
export class SettingSources {
  private readonly sources: Readonly<Record<string, SettingSource>>;

  constructor(sources: Readonly<Record<string, SettingSource>>) {
    this.sources = Object.freeze({ ...sources });
    Object.freeze(this);
  }

  get(name: string): SettingSource | undefined {
    return this.sources[name];
  }
}
