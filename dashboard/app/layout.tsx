import localFont from 'next/font/local';
import InitColorSchemeScript from '@mui/material/InitColorSchemeScript';
import { Shell } from '../components/shell';
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

export const metadata = { title: 'swarmloop' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${sans.variable} ${mono.variable}`}>
        <InitColorSchemeScript attribute="data" defaultMode="system" />
        <ThemeRegistry>
          <Shell>{children}</Shell>
        </ThemeRegistry>
      </body>
    </html>
  );
}
