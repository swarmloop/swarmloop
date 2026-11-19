import { SwarmloopError } from './swarmloop-error';

/** What a refused name is: a branch, a commit message or a merge request title. */
type RefusedKind = 'branch' | 'commit' | 'title';

/** The code host refused a name by a rule of the repository: a ruleset, a push rule or a hook. */
export class GitRuleRefused extends SwarmloopError {
  constructor(
    /** The host's own words. */
    readonly hostMessage: string,
    /** The refused name: the branch, the commit message or the title. */
    override readonly name: string,
    readonly kind: RefusedKind,
  ) {
    super(`${hostMessage} refuses ${name}`, { category: 'provider' });
  }
}
