import type { DocumentEntity, RunEntity } from '../../history/entities';
import { ARTIFACTS } from '../contract/artifacts';
import { OpenItemFacts } from './open-item-facts';
import { OPEN_ITEM_KINDS } from './open-items';

const rules = new OpenItemFacts();
const research = { currentStep: 'research' } as RunEntity;
const requirements = { currentStep: 'requirements' } as RunEntity;
const documents = (...stored: [string, string][]) => stored.map(([kind, body]) => ({ kind, body })) as DocumentEntity[];
const asked = documents(['questions', '- Which store?\n']);

describe('OpenItemFacts', () => {
  it('reads the latest documents of the kinds the open items are read from', () => {
    expect(rules.kinds).toEqual(OPEN_ITEM_KINDS);
  });

  it('says a person is asked when a question is open', () => {
    expect(rules.facts({ run: research, documents: asked, pasteUrls: [], ofBacklog: false })).toEqual({
      needsAnswers: true,
      asksPlanner: false,
    });
  });

  it('says the planner is asked when a question of a backlog run is open', () => {
    expect(rules.facts({ run: research, documents: asked, pasteUrls: [], ofBacklog: true })).toEqual({
      needsAnswers: false,
      asksPlanner: true,
    });
  });

  it('says a person is asked when the planner passed the question on', () => {
    const passed = ARTIFACTS.passedOn.format([{ question: 'Which store?', line: 'You choose.', at: 'now' }]);
    expect(
      rules.facts({
        run: research,
        documents: [...asked, ...documents([ARTIFACTS.passedOn.kind, passed])],
        pasteUrls: [],
        ofBacklog: true,
      }),
    ).toEqual({ needsAnswers: true, asksPlanner: false });
  });

  it('says a person is asked for a pending paste until it is saved', () => {
    const pending = documents(['pending', JSON.stringify({ url: 'https://example.test/p' })]);
    expect(rules.facts({ run: requirements, documents: pending, pasteUrls: [], ofBacklog: false }).needsAnswers).toBe(
      true,
    );
    expect(
      rules.facts({ run: requirements, documents: pending, pasteUrls: ['https://example.test/p'], ofBacklog: false }),
    ).toEqual({ needsAnswers: false, asksPlanner: false });
  });
});
