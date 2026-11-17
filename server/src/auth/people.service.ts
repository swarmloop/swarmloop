import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Clock } from '../core/clock';
import type { PersonView, Role } from '../contract/people';
import { PersonEntity } from '../history/people-entities';
import { PersonalTokens } from './personal-tokens.service';

function viewOf(person: PersonEntity): PersonView {
  return { login: person.login, role: person.role as Role, createdAt: person.createdAt };
}

/** The people of the server and their roles. The first person is an admin; one admin always stays. */
@Injectable()
export class PeopleService implements OnModuleInit {
  constructor(
    private readonly clock: Clock,
    private readonly tokens: PersonalTokens,
    @InjectRepository(PersonEntity) private readonly people: Repository<PersonEntity>,
  ) {}

  /** The first admin owns `SWARMLOOP_TOKEN` from the start of the server. */
  async onModuleInit(): Promise<void> {
    const [first] = await this.people.find({
      where: { role: 'admin' },
      order: { createdAt: 'ASC', login: 'ASC' },
      take: 1,
    });
    if (first) {
      await this.importEnvToken(first);
    }
  }

  /** Imports `SWARMLOOP_TOKEN` once: a person who revoked it does not get it back at the next start. */
  private async importEnvToken(person: PersonEntity): Promise<void> {
    if (person.envTokenImportedAt) {
      return;
    }
    await this.tokens.adoptEnvToken(person.login);
    await this.people.save({ ...person, envTokenImportedAt: this.clock.iso() });
  }

  /** Records a login the first time it is seen: an admin when no admin exists, else a member. */
  async seen(login: string): Promise<void> {
    if (await this.people.existsBy({ login })) {
      return;
    }
    const first = !(await this.people.existsBy({ role: 'admin' }));
    const person = await this.people.save({
      login,
      role: first ? 'admin' : 'member',
      createdAt: this.clock.iso(),
      envTokenImportedAt: null,
    });
    if (first) {
      await this.importEnvToken(person);
    }
  }

  async roleOf(login: string): Promise<Role> {
    return ((await this.people.findOneBy({ login }))?.role as Role | undefined) ?? 'member';
  }

  async isAdmin(login: string): Promise<boolean> {
    return (await this.roleOf(login)) === 'admin';
  }

  async list(): Promise<PersonView[]> {
    return (await this.people.find({ order: { createdAt: 'ASC', login: 'ASC' } })).map(viewOf);
  }

  /** An admin changes the role of a person; the last admin cannot be taken back. */
  async setRole(actor: string, login: string, role: Role): Promise<PersonView> {
    if (!(await this.isAdmin(actor))) {
      throw new ForbiddenException('only an admin can change roles');
    }
    const person = await this.people.findOneBy({ login });
    if (!person) {
      throw new NotFoundException('no such person');
    }
    if (person.role === 'admin' && role !== 'admin' && (await this.people.countBy({ role: 'admin' })) <= 1) {
      throw new ConflictException('one admin must stay');
    }
    return viewOf(await this.people.save({ ...person, role }));
  }
}
