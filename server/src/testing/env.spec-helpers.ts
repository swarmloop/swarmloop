import { writeFile } from 'fs/promises';

import { join } from 'path';

/** Writes only the supplied settings to `<root>/.env`; every other setting comes from `defaults.env`. */
export async function writeEnvOverrides(root: string, overrides: Record<string, string>): Promise<void> {
  const lines = Object.entries(overrides).map(([key, value]) => `${key}=${value}`);
  await writeFile(join(root, '.env'), `${lines.join('\n')}\n`);
}
