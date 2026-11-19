import { remotePushRejection, type CodeHostRules } from '../host-rules';

export const githubRules = {
  name: 'github' as const,
  label: 'GitHub',
  ciFiles: ['.github/workflows/*.yml', '.github/workflows/*.yaml'],
  mergeRequestTemplates: [
    '.github/pull_request_template.md',
    '.github/PULL_REQUEST_TEMPLATE.md',
    'pull_request_template.md',
  ],
  pushRejection: remotePushRejection,
  classifyCall(url: string): string | null {
    const { hostname, pathname } = new URL(url);
    return hostname.toLowerCase() === 'api.github.com' || pathname.startsWith('/api/v3/') ? 'github' : null;
  },
} satisfies CodeHostRules;
