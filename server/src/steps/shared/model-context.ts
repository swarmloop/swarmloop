import { runtimeFor } from '../../integrations/agent-runtime/agent-runtime.registry';

/** The context window of a model in tokens, as its runtime declares it, or null when the runtime or the model is unknown. */
export function modelContextTokens(runtime: string | null, model: string): number | null {
  return runtime ? runtimeFor(runtime).contextTokens(model) : null;
}
