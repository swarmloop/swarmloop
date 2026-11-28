import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { AddRequirementsBody, CloseRequirementBody } from '../../contract/backlog-actions';
import { BacklogActionSupport, outcome, type Outcome, type PlannerContext } from './backlog-action-support';
import { BacklogQueries } from './backlog-queries';
import { checkText, nextRequirementRefs } from './backlog-rules';

/** The requirement writes of a backlog, through the same writer rules as every other backlog write. */
@Injectable()
export class BacklogRequirementActions {
  constructor(
    private readonly queries: BacklogQueries,
    private readonly support: BacklogActionSupport,
  ) {}

  async addRequirements<Context extends PlannerContext | undefined = undefined>(
    actor: string | null,
    name: string,
    number: number,
    body: AddRequirementsBody,
    context?: Context,
  ): Promise<Outcome<Context>> {
    const who = this.support.person(actor);
    const backlog = await this.support.load(name, context);
    const reads = this.support.reads(context);
    const milestone = this.support.milestone(await reads.milestones(backlog.id as number), number);
    if (!Array.isArray(body.texts) || body.texts.length === 0) throw new BadRequestException('no requirement given');
    const texts = body.texts.map((text) => checkText(text, 'a requirement'));
    const taken = (await reads.requirements(backlog.id as number)).map((requirement) => requirement.ref);
    const refs = nextRequirementRefs(number, taken, texts.length);
    await this.support.write(context, async (writers) => {
      for (const [index, text] of texts.entries()) {
        await writers.saveRequirement({ milestoneId: milestone.id as number, ref: refs[index], text, status: 'open' });
      }
      await this.support.record(
        writers,
        backlog.id as number,
        who,
        'add requirements',
        { requirements: refs.join(', ') },
        context,
      );
    });
    return outcome(this.queries, name, context);
  }

  /** Closing is the owner's: an open requirement is closed by hand, with what shows it is met. */
  async closeRequirement<Context extends PlannerContext | undefined = undefined>(
    actor: string | null,
    name: string,
    ref: string,
    body: CloseRequirementBody,
    context?: Context,
  ): Promise<Outcome<Context>> {
    const { who, backlog } = await this.support.owned(actor, name, context);
    const evidence = checkText(body.evidence, 'the evidence');
    const requirement = (await this.support.reads(context).requirements(backlog.id as number)).find(
      (other) => other.ref === ref,
    );
    if (requirement === undefined) throw new NotFoundException(`no requirement ${ref}`);
    if (requirement.status === 'closed') throw new ConflictException(`${ref} is already closed`);
    await this.support.write(context, async (writers) => {
      await writers.saveRequirement({ ...requirement, status: 'closed' });
      await this.support.record(
        writers,
        backlog.id as number,
        who,
        'close requirement',
        { requirement: ref, evidence },
        context,
      );
    });
    return outcome(this.queries, name, context);
  }
}
