import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RootLayout from './layout';

vi.mock('next/font/local', () => ({ default: () => ({ variable: 'font' }) }));
vi.mock('@mui/material/InitColorSchemeScript', () => ({ default: () => null }));
vi.mock('./dashboard-shell', () => ({ DashboardShell: () => null }));
vi.mock('./theme-registry', () => ({ ThemeRegistry: () => null }));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('RootLayout', () => {
  it('hands the socket URL of the env to the browser', () => {
    vi.stubEnv('SWARMLOOP_SOCKET_URL', 'http://live.example:7</script>');

    const html = renderToStaticMarkup(RootLayout({ children: null }));

    expect(html).toContain('window.__SWARMLOOP_SOCKET__="http://live.example:7\\u003c/script>"');
  });
});
