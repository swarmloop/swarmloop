import { BadRequestException, Body, Controller, ForbiddenException, Get, Param, Put } from '@nestjs/common';
import type { PeopleView, PersonView, SetRoleBody } from '../contract/people';
import { Actor } from './actor.decorator';
import { PeopleService } from './people.service';

/** The people of the server, for admins. */
@Controller('people')
export class PeopleController {
  constructor(private readonly people: PeopleService) {}

  @Get()
  async list(@Actor() actor: string | null): Promise<PeopleView> {
    if (!actor || !(await this.people.isAdmin(actor))) {
      throw new ForbiddenException('only an admin can list people');
    }
    return { people: await this.people.list() };
  }

  @Put(':login/role')
  setRole(
    @Actor() actor: string | null,
    @Param('login') login: string,
    @Body() body: SetRoleBody,
  ): Promise<PersonView> {
    if (body?.role !== 'member' && body?.role !== 'admin') {
      throw new BadRequestException('role must be member or admin');
    }
    return this.people.setRole(actor ?? '', login, body.role);
  }
}
