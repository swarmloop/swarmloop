import { appFlowApps, appFlowRoutes, applicationRoutes, routeHost } from './host-routes';

describe('host routes', () => {
  it('names the routes of the hosts that have an app flow', () => {
    expect(appFlowRoutes('owner')).toEqual(['github/owner']);
  });

  it('names the routes of the hosts that store an application', () => {
    expect(applicationRoutes('application')).toEqual(['gitlab/application']);
  });

  it('names the apps of the hosts that have an app flow', () => {
    expect(appFlowApps()).toBe('GitHub App');
  });

  it('reads the host from the matched route', () => {
    expect(routeHost({ route: { path: '/connections/github/app' } })).toBe('github');
    expect(routeHost({ route: { path: '/auth/github/created' } })).toBe('github');
    expect(routeHost({})).toBe('');
  });
});
