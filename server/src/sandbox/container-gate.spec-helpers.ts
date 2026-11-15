import type { EventEmitter } from 'events';
import type { ContainerGate } from './container-gate';
import type { SandboxChild, SandboxService } from './sandbox.service';

type Spawn = SandboxService['spawn'];

/** Wraps a fake spawn the way `SandboxService.spawn` gates a held container. */
export function heldSpawn(gate: ContainerGate, spawn: (...args: Parameters<Spawn>) => Promise<EventEmitter>): Spawn {
  return async (given, held) => {
    const release = held ? await gate.admit(held.onPaused, given.runKey, held.agent) : undefined;
    const child = await spawn(given, held).catch((error: unknown) => {
      release?.();
      throw error;
    });
    if (release) {
      child.once('close', release);
      child.once('error', release);
    }
    return child as SandboxChild;
  };
}
