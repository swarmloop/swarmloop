import type { CodeHostRules } from '../host-rules';

export const gitlabRules = {
  name: 'gitlab' as const,
  label: 'GitLab',
  ciFiles: ['.gitlab-ci.yml'],
  pushRejection(lines: string[]): string | undefined {
    return lines.find((line) => line.includes('remote rejected') || line.startsWith('remote: GitLab'));
  },
  classifyCall(url: string): string | null {
    return new URL(url).pathname.startsWith('/api/v4/') ? 'gitlab' : null;
  },
} satisfies CodeHostRules;
