import { redact } from './redact';

const ENV = {
  JIRA_API_TOKEN: 'jira-secret-value',
  DB_PASSWORD: 'hunter22',
  SWARMLOOP_API_PORT: 3920,
  GITLAB_TOKEN: '',
};

describe('redact', () => {
  it.each<[string, string, string]>([
    ['a clean string', 'nothing to hide here', 'nothing to hide here'],
    ['a GitHub token', 'token ghp_abcDEF123456 used', 'token *** used'],
    ['a GitHub fine-grained token', 'github_pat_11AB_cd45 end', '*** end'],
    ['a GitLab token', 'glpat-abc123-xyz failed', '*** failed'],
    ['an OpenAI-style key', 'key sk-proj-abc123', 'key ***'],
    ['a Slack bot token', 'xoxb-123-456-abc', '***'],
    ['a Slack app token', 'xoxa-123-456-abc', '***'],
    ['a Slack personal token', 'xoxp-123-456-abc', '***'],
    ['a Bearer value', 'sent Bearer abc.def.ghi to host', 'sent Bearer *** to host'],
    ['an Authorization header', 'Authorization: Basic dXNlcjpwYXNz', 'Authorization: ***'],
    ['credentials in a URL', 'clone https://user:pass@github.com/a/b.git', 'clone https://***@github.com/a/b.git'],
    ['a password that contains an @', 'https://user:p@ss@host/x', 'https://***@host/x'],
    ['a token inside a URL', 'GET https://api.test/x?token=ghp_abc123', 'GET https://api.test/x?token=***'],
    ['a token and credentials in one URL', 'https://u:p@h/x?t=glpat-abc', 'https://***@h/x?t=***'],
    [
      'a multi-line stack',
      'Error: bad ghp_aaa111\n    at run (https://u:p@h/f.js:1:1)\n    at Authorization: abc\n    at ok',
      'Error: bad ***\n    at run (https://***@h/f.js:1:1)\n    at Authorization: ***\n    at ok',
    ],
    ['an env token value', 'failed with jira-secret-value now', 'failed with *** now'],
    ['a repeated env value', 'hunter22 and hunter22', '*** and ***'],
    ['an env value in a multi-line text', 'a\nline hunter22\nb', 'a\nline ***\nb'],
    ['a non-secret env value', 'port 3920 open', 'port 3920 open'],
    ['an empty env value', 'GITLAB_TOKEN= is empty', 'GITLAB_TOKEN= is empty'],
  ])('masks %s', (_name, input, expected) => {
    expect(redact(input, ENV)).toBe(expected);
  });

  it('masks the longer env value first', () => {
    expect(redact('abcd1234 abcd', { A_TOKEN: 'abcd', B_TOKEN: 'abcd1234' })).toBe('*** ***');
  });

  it('skips env values shorter than four characters', () => {
    expect(redact('pw abc', { A_PASSWORD: 'abc' })).toBe('pw abc');
  });

  it('works without an env', () => {
    expect(redact('ghp_abc123')).toBe('***');
  });
});
