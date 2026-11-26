import type { ReactElement } from 'react';
import Typography from '@mui/material/Typography';
import { releaseNotesUrl, versionLabel } from './account-links';

interface AccountVersionProps {
  version: string;
  revision: string | undefined;
  sourceUrl: string | null;
}

/** `swarmloop v0.4.0`, or `swarmloop v0.3.2 · ae0a069` for a build from source; the version links to its notes. */
export function AccountVersion({ version, revision, sourceUrl }: AccountVersionProps): ReactElement {
  const label = versionLabel(version);
  if (!revision) {
    const text = `swarmloop ${label}`;
    return sourceUrl ? (
      <Typography
        variant="caption"
        color="text.secondary"
        component="a"
        href={releaseNotesUrl(sourceUrl, version)}
        target="_blank"
        rel="noreferrer"
      >
        {text}
      </Typography>
    ) : (
      <Typography variant="caption" color="text.secondary">
        {text}
      </Typography>
    );
  }
  return (
    <Typography variant="caption" color="text.secondary">
      {'swarmloop '}
      {sourceUrl ? (
        <a href={releaseNotesUrl(sourceUrl, version)} target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>
          {label}
        </a>
      ) : (
        label
      )}
      {` · ${revision}`}
    </Typography>
  );
}
