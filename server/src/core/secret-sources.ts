const MIN_SECRET_LENGTH = 4;

const remembered = new Set<string>();
const sources = new Set<() => string[]>();

/** Stored secrets are masked wherever a message is redacted, like the secret env values. */
export function rememberSecret(value: string): void {
  if (value.length >= MIN_SECRET_LENGTH) {
    remembered.add(value);
  }
}

/** An owner of secrets lists them through this source, read each time a message is redacted. Returns the way to stop. */
export function registerSecretSource(source: () => string[]): () => void {
  sources.add(source);
  return () => {
    sources.delete(source);
  };
}

/** Every remembered secret and every secret of a registered source. */
export function knownSecrets(): string[] {
  const listed = [...sources].flatMap((source) => source());
  return [...new Set([...remembered, ...listed].filter((value) => value.length >= MIN_SECRET_LENGTH))];
}
