import { Injectable } from '@nestjs/common';
import { PeopleService } from './people.service';

/** Who may replace the app of a host: the person who made it, or an admin. */
@Injectable()
export class AppReplacePolicy {
  constructor(private readonly people: PeopleService) {}

  async mayReplace(actor: string, madeBy: string | null | undefined): Promise<boolean> {
    return actor === madeBy || (await this.people.isAdmin(actor));
  }
}
