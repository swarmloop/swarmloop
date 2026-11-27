import { BadRequestException } from '@nestjs/common';
import { projectsOf } from './run-input';

describe('projectsOf', () => {
  it('keeps checkout names and owner/name picks of remote repositories, sorted', () => {
    expect(projectsOf(['acme/team/apps/app', 'docs', 'docs'], null)).toEqual(['acme/team/apps/app', 'docs']);
  });

  it('prefers the projects a run already stores', () => {
    expect(projectsOf(['docs'], 'app\n')).toEqual(['app']);
  });

  it.each(['acme/../x', '.hidden', 'run-x', 'acme/run-x', 'acme/'])('refuses %s as a project', (name) => {
    expect(() => projectsOf([name], null)).toThrow(new BadRequestException(`${name} is not a project`));
  });
});
