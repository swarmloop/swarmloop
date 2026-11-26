import { runtimeFor } from '../../integrations/agent-runtime/agent-runtime.registry';

/** How long a chat stays in its model's prompt cache, and how many pings keep it there before one rewrite is cheaper. */
interface ChatCache {
  ttlMinutes: number;
  maxPings: number;
}

/** What the runtime of a chat says of its prompt cache, or null when it declares none: such a chat is never pinged. */
export function chatCache(runtime: string | null, model: string): ChatCache | null {
  const cache = runtime ? runtimeFor(runtime).promptCache(model) : null;
  return (
    cache && {
      ttlMinutes: cache.ttlMinutes,
      maxPings: Math.floor(cache.cacheWritePerMillion / cache.cacheReadPerMillion),
    }
  );
}
