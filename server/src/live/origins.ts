const PANEL_ORIGINS = ['http://127.0.0.1:3921', 'http://localhost:3921'];

/** The panel origins plus the origin of the public URL, which is the dashboard of a team server. */
export function allowedOrigins(publicUrl: string): string[] {
  return [...PANEL_ORIGINS, new URL(publicUrl).origin];
}

/** A browser page may call the API only from a panel origin. */
export function originAllowed(origin: string, publicUrl: string): boolean {
  return allowedOrigins(publicUrl).includes(origin);
}
