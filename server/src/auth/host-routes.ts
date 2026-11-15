import { codeHostAdapters } from '../integrations/code-host/code-host-adapters';

/** The paths of a route that goes through the app flow of each host that has one: `<host>/<route>`. */
export function appFlowRoutes(route: string): string[] {
  return codeHostAdapters()
    .filter((adapter) => adapter.appFlow)
    .map((adapter) => `${adapter.name}/${route}`);
}

/** The paths of a route of each host that stores an application the person registers with it. */
export function applicationRoutes(route: string): string[] {
  return codeHostAdapters()
    .filter((adapter) => adapter.storesApplication)
    .map((adapter) => `${adapter.name}/${route}`);
}

/** The apps of the hosts that have an app flow, as a person reads them. */
export function appFlowApps(): string {
  return codeHostAdapters()
    .filter((adapter) => adapter.appFlow)
    .map((adapter) => `${adapter.label} ${adapter.appLabel}`)
    .join(' or ');
}

/** The host a host-named route matched: the segment before the route's last one. */
export function routeHost(request: { route?: { path?: string } }): string {
  const segments = (request.route?.path ?? '').split('/').filter(Boolean);
  return segments[segments.length - 2] ?? '';
}
