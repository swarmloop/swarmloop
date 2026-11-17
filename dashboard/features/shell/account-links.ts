const RELEASE_VERSION = /^\d+\.\d+\.\d+/;

/** The README of the code host, where the documentation lives. */
export function readmeUrl(sourceUrl: string): string {
  return `${sourceUrl}#readme`;
}

/** The release notes of a release version; any other version points at the list of releases. */
export function releaseNotesUrl(sourceUrl: string, version: string): string {
  return RELEASE_VERSION.test(version) ? `${sourceUrl}/releases/tag/v${version}` : `${sourceUrl}/releases`;
}
