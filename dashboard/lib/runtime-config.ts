const DEFAULT_API_URL = 'http://127.0.0.1:3920';

declare global {
  interface Window {
    /** Set by the root layout from the container env, so the socket URL is not baked into the build. */
    __SWARMLOOP_SOCKET__?: string;
  }
}

/** Read on every call: the dashboard image takes its API URL from the env at container start. */
export function apiBaseUrl(): string {
  return process.env.SWARMLOOP_API_URL ?? DEFAULT_API_URL;
}

export function socketUrl(): string {
  if (typeof window !== 'undefined' && window.__SWARMLOOP_SOCKET__) {
    return window.__SWARMLOOP_SOCKET__;
  }
  return process.env.SWARMLOOP_SOCKET_URL ?? DEFAULT_API_URL;
}
