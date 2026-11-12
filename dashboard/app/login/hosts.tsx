import type { ComponentType } from 'react';
import SvgIcon from '@mui/material/SvgIcon';
import PublicIcon from '@mui/icons-material/Public';

interface HostEntry {
  label: string;
  Mark: ComponentType;
  /** The host's own sign-out page; the login card links to it when a refusal may come from another account. */
  signOutUrl?: string;
  /** The host whose login the install screens lead to. */
  installs?: true;
}

function GitHubMark(): React.ReactElement {
  return (
    <SvgIcon data-testid="mark-github">
      <path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.15-1.11-1.46-1.11-1.46-.9-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.89 1.52 2.34 1.08 2.91.83.09-.65.35-1.08.63-1.33-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02a9.5 9.5 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.69-4.57 4.93.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2Z" />
    </SvgIcon>
  );
}

function GitLabMark(): React.ReactElement {
  return (
    <SvgIcon data-testid="mark-gitlab">
      <path d="m22.65 14.39-1.2-3.7-2.4-7.36a.42.42 0 0 0-.8 0l-2.4 7.36H8.15l-2.4-7.36a.42.42 0 0 0-.8 0l-2.4 7.36-1.2 3.7a.84.84 0 0 0 .3.94L12 21.5l10.35-6.17a.84.84 0 0 0 .3-.94Z" />
    </SvgIcon>
  );
}

function NeutralMark(): React.ReactElement {
  return <PublicIcon data-testid="mark-neutral" />;
}

export const HOSTS: Record<string, HostEntry> = {
  github: {
    label: 'GitHub',
    Mark: GitHubMark,
    signOutUrl: 'https://github.com/logout',
    installs: true,
  },
  gitlab: { label: 'GitLab', Mark: GitLabMark, signOutUrl: 'https://gitlab.com/users/sign_out' },
};

/** A known host, or a neutral entry that shows the raw name, so a new host needs one entry in HOSTS. */
export function hostOf(name: string): HostEntry {
  return HOSTS[name] ?? { label: name, Mark: NeutralMark };
}

/** The key of the host the install screens log in to. */
export function installHost(): string {
  const entry = Object.entries(HOSTS).find(([, host]) => host.installs);
  return entry ? entry[0] : '';
}
