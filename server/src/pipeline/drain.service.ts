import { Injectable } from '@nestjs/common';

/** Whether this instance takes new runs and new steps. It is not stored: a restart ends a drain. */
@Injectable()
export class DrainService {
  private on = false;

  get draining(): boolean {
    return this.on;
  }

  start(): void {
    this.on = true;
  }
}
