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
export function doorAround(app: Providers, launcher: Pick<AgentLauncher, 'launch'>): AgentDoor {
  return new AgentDoor(
    launcher as AgentLauncher,
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
