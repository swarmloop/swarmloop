import { describe, expect, it } from 'vitest';
import { httpAction } from './http-action';

const GH = 'https://ghe.github.com/repos/o/r';
const GL = 'https://gitlab.example/projects/1';

describe('httpAction', () => {
  it.each([
    ['POST', `${GH}/pulls`, 'GitHub: create pull request'],
    ['GET', `${GH}/pulls/7`, 'GitHub: read pull request #7'],
    ['PATCH', `${GH}/pulls/7`, 'GitHub: update pull request #7'],
    ['GET', `${GH}/actions/runs/42`, 'GitHub: workflow run 42 status'],
    ['GET', 'https://git.example/x/pulls', 'GET git.example'],
    ['GET', 'https://ghe.github.com/x/pipelines/3', 'GitLab: pipeline 3 status'],
    ['GET', `${GL}/pipelines/9`, 'GitLab: pipeline 9 status'],
    ['GET', `${GL}/jobs/5/trace`, 'GitLab: job 5 log'],
    ['POST', `${GL}/merge_requests`, 'GitLab: create merge request'],
    ['GET', `${GL}/merge_requests/3`, 'GitLab: read merge request !3'],
    ['PUT', `${GL}/merge_requests/3`, 'GitLab: update merge request !3'],
    ['GET', 'https://jira.example/rest/api/2/issue/PROJ-1', 'Jira: read PROJ-1'],
    ['GET', 'https://x.example/other', 'GET x.example'],
    ['GET', 'not a url', 'GET call'],
  ])('%s %s is %s', (method, url, label) => {
    expect(httpAction(method, url)).toBe(label);
  });
});
