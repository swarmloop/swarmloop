import localFont from 'next/font/local';
import InitColorSchemeScript from '@mui/material/InitColorSchemeScript';
import { socketUrl } from '../lib/runtime-config';
import { DashboardShell } from './dashboard-shell';
import { ThemeRegistry } from './theme-registry';

// The fonts live in the repository, so `next build` needs no network (a Google Fonts fetch failed CI builds at random).
const sans = localFont({
  src: [
    { path: './fonts/IBMPlexSans-Regular.woff2', weight: '400', style: 'normal' },
    { path: './fonts/IBMPlexSans-Medium.woff2', weight: '500', style: 'normal' },
    { path: './fonts/IBMPlexSans-SemiBold.woff2', weight: '600', style: 'normal' },
  ],
  variable: '--font-sans',
});
const mono = localFont({
  src: [
    { path: './fonts/IBMPlexMono-Regular.woff2', weight: '400', style: 'normal' },
    { path: './fonts/IBMPlexMono-Medium.woff2', weight: '500', style: 'normal' },
  ],
  variable: '--font-mono',
});

// The socket URL comes from the env at request time, so the page cannot be prerendered.
export const dynamic = 'force-dynamic';

export const metadata = { title: 'swarmloop' };

export default function RootLayout({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `window.__SWARMLOOP_SOCKET__=${JSON.stringify(socketUrl()).replace(/</g, '\\u003c')};`,
          }}
        />
      </head>
      <body className={`${sans.variable} ${mono.variable}`}>
        <InitColorSchemeScript attribute="data" defaultMode="system" />
        <ThemeRegistry>
          <DashboardShell>{children}</DashboardShell>
        </ThemeRegistry>
      </body>
    </html>
  );
}
