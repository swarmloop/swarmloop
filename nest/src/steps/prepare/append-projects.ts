import { SwarmloopError } from '../../swarmloop-error';

export function appendProjectNames(current: string[], incoming: string[]): { projects: string[]; added: string[] } {
  for (const name of current) {
    if (!incoming.includes(name)) {
      throw new SwarmloopError(`${name} cannot be removed`);
    }
  }
  const added = incoming.filter((name) => !current.includes(name));
  return { projects: [...current, ...added], added };
}
