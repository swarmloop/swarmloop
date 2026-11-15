import type { ElementType } from 'react';
import Bolt from '@mui/icons-material/Bolt';
import Cloud from '@mui/icons-material/Cloud';
import Code from '@mui/icons-material/Code';
import Extension from '@mui/icons-material/Extension';
import GitHub from '@mui/icons-material/GitHub';
import Hub from '@mui/icons-material/Hub';
import Source from '@mui/icons-material/Source';
import Terminal from '@mui/icons-material/Terminal';

/** The only place in the dashboard that names an integration: a logo key to its icon. */
const LOGOS: Record<string, ElementType> = {
  claude: Bolt,
  codex: Terminal,
  cursor: Code,
  jira: Hub,
  confluence: Cloud,
  github: GitHub,
  gitlab: Source,
};

/** A key the map does not know gets one neutral icon, so a new integration needs only an entry here. */
export function logoFor(key: string): ElementType {
  return LOGOS[key] ?? Extension;
}

interface HostTexts {
  key: string;
  label: string;
  /** The first-run form: a manifest for an app, or the application the person already made. */
  firstRun: { kind: 'manifest' | 'application'; title: string; description: string; submit: string };
  /** The words of the Replace dialog, for a host whose app the server creates. */
  replace?: { stays: string; settings: string };
  /** Whether the host's calls go to this hostname. */
  servesHost: (hostname: string) => boolean;
  /** The label of an HTTP call by its method and path, when the host's rules know it. */
  action: (method: string, path: string) => string | undefined;
}

function verbOf(method: string): string {
  return method === 'POST' ? 'create' : method === 'GET' ? 'read' : 'update';
}

/** The host words a person sees and the hostname matching, in the order the first-run screen shows them. */
export const HOST_TEXTS: readonly HostTexts[] = [
  {
    key: 'github',
    label: 'GitHub',
    firstRun: {
      kind: 'manifest',
      title: 'Connect GitHub',
      description: 'Creates a GitHub App for you, from a manifest. You then install it on the repositories you choose.',
      submit: 'Create GitHub App',
    },
    replace: { stays: 'The app on GitHub stays', settings: 'GitHub settings' },
    servesHost: (hostname) => hostname === 'api.github.com' || hostname.endsWith('.github.com'),
    action: (method: string, path: string): string | undefined => {
      const pull = /\/pulls(?:\/(\d+))?$/.exec(path);
      if (pull) {
        return `GitHub: ${verbOf(method)} pull request${pull[1] ? ` #${pull[1]}` : ''}`;
      }
      const run = /\/actions\/runs\/(\d+)/.exec(path);
      return run ? `GitHub: workflow run ${run[1]} status` : undefined;
    },
  },
  {
    key: 'gitlab',
    label: 'GitLab',
    firstRun: {
      kind: 'application',
      title: 'Connect GitLab',
      description: 'The OAuth application of your GitLab, with scopes read_user, api and write_repository.',
      submit: 'Connect GitLab',
    },
    servesHost: () => true,
    action: (method: string, path: string): string | undefined => {
      const pipeline = /\/pipelines\/(\d+)/.exec(path);
      if (pipeline) {
        return `GitLab: pipeline ${pipeline[1]} status`;
      }
      const job = /\/jobs\/(\d+)\/trace/.exec(path);
      if (job) {
        return `GitLab: job ${job[1]} log`;
      }
      const merge = /\/merge_requests(?:\/(\d+))?$/.exec(path);
      return merge ? `GitLab: ${verbOf(method)} merge request${merge[1] ? ` !${merge[1]}` : ''}` : undefined;
    },
  },
];

export function hostTexts(key: string): HostTexts | undefined {
  return HOST_TEXTS.find((entry) => entry.key === key);
}
