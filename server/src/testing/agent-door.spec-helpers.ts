import type { Type } from '@nestjs/common';
import { RunStop } from '../agent/run-stop';
import { AppConfig } from '../config/env';
import { Clock } from '../core/clock';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { VisitRepository } from '../history/visit.repository';
import { VisitStartRepository } from '../history/visit-start.repository';
import { AgentDoor } from '../steps/shared/agent-door';
import type { AgentLauncher } from '../steps/shared/agent-launcher';
import { SpendLimit } from '../steps/shared/spend-limit';

/** Anything that finds the app's providers: the application a spec booted. */
interface Providers {
  get<T>(token: Type<T> | (abstract new (...args: never[]) => T)): T;
}

/** The door of a run's agent starts around a given launcher and the app's repositories, for specs with a fake launcher. */
export function doorAround(
  app: Providers,
  launcher: Pick<AgentLauncher, 'launch'> & Partial<Pick<AgentLauncher, 'refused'>>,
): AgentDoor {
  return new AgentDoor(
    { refused: async () => undefined, ...launcher } as AgentLauncher,
    app.get(RunRepository),
    app.get(VisitRepository),
    app.get(VisitStartRepository),
    app.get(DocumentRepository),
    app.get(SpendLimit),
    app.get(AppConfig),
    app.get(RunStop),
    app.get(Clock),
  );
}

/** A door that launches every outside start through `launch`, hands out start ids, and records the links of visits. */
export function launchingDoor(launch: (request: never) => Promise<unknown>, links: [string, number][] = []): AgentDoor {
  let started = 0;
  return {
    outside: async (start: { admitted?: (id: string) => void }, request: never) => {
      started += 1;
      start.admitted?.(`start-${started}`);
      return launch(request);
    },
    linkVisit: async (startId: string, statId: number) => void links.push([startId, statId]),
    takeRefusal: () => null,
  } as unknown as AgentDoor;
}
