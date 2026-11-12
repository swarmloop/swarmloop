/** The Location of a redirect as a path and its query values, to assert a login problem without string matching. */
export function redirectOf(response: Response): { path: string; query: Record<string, string> } {
  expect(response.status).toBe(302);
  const url = new URL(response.headers.get('location') ?? '', 'http://swarmloop.test');
  return { path: url.pathname, query: Object.fromEntries(url.searchParams) };
}
