import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { Actor } from '../auth/actor.decorator';
import type { BacklogView } from '../contract/backlog';
import type {
  AddItemBody,
  AddRepositoryBody,
  AddRequirementsBody,
  AddTaskBody,
  ChangeTaskBody,
  CloseRequirementBody,
  CreateBacklogBody,
  MoveItemBody,
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

  @Post(':name/requirements/:ref/close')
  closeRequirement(
    @Actor() actor: string | null,
    @Param('name') name: string,
    @Param('ref') ref: string,
    @Body() body: CloseRequirementBody,
  ): Promise<BacklogView> {
    return this.actions.closeRequirement(actor, name, ref, body);
  }

  @Post(':name/tasks')
  addTasks(
    @Actor() actor: string | null,
    @Param('name') name: string,
    @Body() body: AddTaskBody[],
  ): Promise<BacklogView> {
    return this.actions.addTasks(actor, name, body);
  }

  @Patch(':name/tasks/:slug')
  changeTask(
    @Actor() actor: string | null,
    @Param('name') name: string,
    @Param('slug') slug: string,
    @Body() body: ChangeTaskBody,
  ): Promise<BacklogView> {
    return this.actions.changeTask(actor, name, slug, body);
  }

  @Delete(':name/tasks/:slug')
  deleteTask(
    @Actor() actor: string | null,
    @Param('name') name: string,
    @Param('slug') slug: string,
  ): Promise<BacklogView> {
    return this.actions.deleteTask(actor, name, slug);
  }

  @Post(':name/tasks/:slug/skip')
  skipTask(
    @Actor() actor: string | null,
    @Param('name') name: string,
    @Param('slug') slug: string,
  ): Promise<BacklogView> {
    return this.actions.skipTask(actor, name, slug);
  }

  @Post(':name/tasks/:slug/merge')
  mergeTask(
    @Actor() actor: string | null,
    @Param('name') name: string,
    @Param('slug') slug: string,
  ): Promise<BacklogView> {
    return this.actions.mergeTask(actor, name, slug);
  }

  @Post(':name/tasks/:slug/run')
  runTaskNow(
    @Actor() actor: string | null,
    @Param('name') name: string,
    @Param('slug') slug: string,
  ): Promise<BacklogView> {
    return this.actions.runTaskNow(actor, name, slug);
  }

  @Post(':name/items')
  addItem(@Actor() actor: string | null, @Param('name') name: string, @Body() body: AddItemBody): Promise<BacklogView> {
    return this.actions.addItem(actor, name, body);
  }

  @Patch(':name/items/:slug')
  moveItem(
    @Actor() actor: string | null,
    @Param('name') name: string,
    @Param('slug') slug: string,
    @Body() body: MoveItemBody,
  ): Promise<BacklogView> {
    return this.actions.moveItem(actor, name, slug, body);
  }

  @Delete(':name/items/:slug')
  dropItem(
    @Actor() actor: string | null,
    @Param('name') name: string,
    @Param('slug') slug: string,
  ): Promise<BacklogView> {
    return this.actions.dropItem(actor, name, slug);
  }
}
