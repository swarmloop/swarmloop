import { PasteNeeded, SwarmloopError } from '../../core/swarmloop-error';
import { StepKernel } from '../step-kernel';
import type { IssueBundle } from '../../integrations/issue-tracker/issue-bundle';
import type { IssueTracker } from '../../integrations/issue-tracker/issue-tracker';
import { ISSUE_TRACKER } from '../../integrations/issue-tracker/tokens';
import { REQUIREMENTS_SOURCE } from '../../integrations/requirements-source/requirements-source.module';
import type { RequirementsSource } from '../../integrations/requirements-source/requirements-source';
import { expectGolden } from '../../testing/step-trace.spec-helpers';
import { goldenApp } from '../shared/model-golden.spec-helpers';
import { RemoteRepositories } from '../prepare/remote-repositories.service';
import { RequirementsStep } from './requirements.step';

const KEY = 'PROJ-1';
const SECOND = 'PROJ-2';

function bundle(key: string): IssueBundle {
  return {
    key,
    summary: `Summary of ${key}`,
    descriptionMarkdown: `Description of ${key}`,
    acceptanceCriteria: 'Must ship',
    epic: null,
    comments: [],
    attachments: [],
    links: [],
    confluence: [],
    pages: [],
  };
}

type Fetch = IssueTracker['fetch'];

async function requirements(fetch: Fetch) {
  const tracker: IssueTracker = {
    fetch: (...args) => fetch(...args),
    ticketKeys: async (text) => text.match(/PROJ-\d+/g) ?? [],
  };
  const golden = await goldenApp('requirements-golden', {
    configure: (builder) => builder.overrideProvider(ISSUE_TRACKER).useValue(tracker),
  });
  const step = new RequirementsStep(
    new StepKernel(
      golden.runs,
      golden.documents,
      golden.visits,
      golden.flows,
      golden.clock,
      golden.config,
      golden.stepEvents,
    ),
    tracker,
    golden.app.get<RequirementsSource>(REQUIREMENTS_SOURCE),
    golden.app.get(RemoteRepositories),
  );
  return { golden, step };
}

const found = (key: string): ReturnType<Fetch> => Promise.resolve({ bundle: bundle(key), httpCalls: [] });
/** The first issue is fetched and stored; the second one fails. */
const failing =
  (error: Error): Fetch =>
  (key) =>
    key === SECOND ? Promise.reject(error) : found(key);
const TWO = `Ship the field for ${KEY} and ${SECOND}\n`;

describe('requirements step golden traces', () => {
  const scenarios: [string, Fetch][] = [
    ['ok', found],
    ['swarmloop-error', failing(new SwarmloopError('issue tracker said no'))],
    ['plain-error', failing(new Error('socket hang up'))],
  ];
  it.each(scenarios)('%s', async (name, fetch) => {
    const { golden, step } = await requirements(fetch);
    try {
      await step.execute(KEY, { prompt: TWO });
      expectGolden(`requirements.${name}`, await golden.trace(KEY, 'requirements'));
    } finally {
      await golden.close();
    }
  });

  it('questions-open: a page needs a paste, so the run waits', async () => {
    const { golden, step } = await requirements((key) =>
      key === SECOND ? Promise.reject(new PasteNeeded('https://wiki.example/page', [])) : found(key),
    );
    try {
      await step.execute(KEY, { prompt: TWO });
      expectGolden('requirements.questions-open', await golden.trace(KEY, 'requirements'));
    } finally {
      await golden.close();
    }
  });

  it('answered: the paste is given, so the run resumes from the stored progress', async () => {
    let answered = false;
    const { golden, step } = await requirements((key) =>
      key === SECOND && !answered ? Promise.reject(new PasteNeeded('https://wiki.example/page', [])) : found(key),
    );
    try {
      await step.execute(KEY, { prompt: TWO });
      answered = true;
      await step.execute(KEY);
      expectGolden('requirements.answered', await golden.trace(KEY, 'requirements'));
    } finally {
      await golden.close();
    }
  });
});
