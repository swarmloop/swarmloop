import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { Actor } from '../auth/actor.decorator';
import type { BacklogView } from '../contract/backlog';
import type {
  AddRepositoryBody,
  AddRequirementsBody,
  CreateBacklogBody,
  ProposeMilestoneBody,
  RecordDecisionBody,
} from '../contract/backlog-actions';
import { BacklogActions } from '../pipeline/backlog/backlog-actions';
import { BacklogQueries } from '../pipeline/backlog/backlog-queries';

@Controller('backlogs')
export class BacklogsController {
  constructor(
    private readonly actions: BacklogActions,
    private readonly queries: BacklogQueries,
  ) {}

  @Post()
  create(@Actor() actor: string | null, @Body() body: CreateBacklogBody): Promise<BacklogView> {
    return this.actions.createBacklog(actor, body);
  }

  @Get()
  list(): Promise<BacklogView[]> {
    return this.queries.list();
  }

  @Get(':name')
  view(@Param('name') name: string): Promise<BacklogView> {
    return this.queries.view(name);
  }

  @Post(':name/run')
  run(@Actor() actor: string | null, @Param('name') name: string): Promise<BacklogView> {
    return this.actions.runBacklog(actor, name);
  }

  @Post(':name/pause')
  pause(@Actor() actor: string | null, @Param('name') name: string): Promise<BacklogView> {
    return this.actions.pause(actor, name);
  }

  @Delete(':name/pause')
  unpause(@Actor() actor: string | null, @Param('name') name: string): Promise<BacklogView> {
    return this.actions.unpause(actor, name);
  }

  @Post(':name/repositories')
  addRepository(
    @Actor() actor: string | null,
    @Param('name') name: string,
    @Body() body: AddRepositoryBody,
  ): Promise<BacklogView> {
    return this.actions.addRepository(actor, name, body);
  }

  @Post(':name/decisions')
  recordDecision(
    @Actor() actor: string | null,
    @Param('name') name: string,
    @Body() body: RecordDecisionBody,
  ): Promise<BacklogView> {
    return this.actions.recordDecision(actor, name, body);
  }

  @Post(':name/milestones')
  proposeMilestone(
    @Actor() actor: string | null,
    @Param('name') name: string,
    @Body() body: ProposeMilestoneBody,
  ): Promise<BacklogView> {
    return this.actions.proposeMilestone(actor, name, body);
  }

  @Post(':name/milestones/:number/run')
  runMilestone(
    @Actor() actor: string | null,
    @Param('name') name: string,
    @Param('number', ParseIntPipe) number: number,
  ): Promise<BacklogView> {
    return this.actions.runMilestone(actor, name, number);
  }

  @Post(':name/milestones/:number/accept')
  acceptMilestone(
    @Actor() actor: string | null,
    @Param('name') name: string,
    @Param('number', ParseIntPipe) number: number,
  ): Promise<BacklogView> {
    return this.actions.acceptMilestone(actor, name, number);
  }

  @Post(':name/milestones/:number/requirements')
  addRequirements(
    @Actor() actor: string | null,
    @Param('name') name: string,
    @Param('number', ParseIntPipe) number: number,
    @Body() body: AddRequirementsBody,
  ): Promise<BacklogView> {
    return this.actions.addRequirements(actor, name, number, body);
  }
}
