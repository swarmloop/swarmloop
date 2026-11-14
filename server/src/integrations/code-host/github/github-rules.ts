import { remotePushRejection, type CodeHostRules } from '../host-rules';

export const githubRules = {
  name: 'github' as const,
  label: 'GitHub',
  ciFiles: ['.github/workflows/*.yml', '.github/workflows/*.yaml'],
  pushRejection: remotePushRejection,
  classifyCall(url: string): string | null {
    const { hostname, pathname } = new URL(url);
    return hostname.toLowerCase() === 'api.github.com' || pathname.startsWith('/api/v3/') ? 'github' : null;
  },
} satisfies CodeHostRules;
