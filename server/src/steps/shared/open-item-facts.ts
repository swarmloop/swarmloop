import { Injectable } from '@nestjs/common';
import { OpenItemRules } from '../../history/open-item-rules';
import { OPEN_ITEM_KINDS, openItems } from './open-items';
import { holdFacts, markHolders } from './question-holds';

/** The open-item rule of a run: the kinds its items are read from, and the facts they give. */
@Injectable()
export class OpenItemFacts extends OpenItemRules {
  readonly kinds = OPEN_ITEM_KINDS;

  facts({
    run,
    documents,
    pasteUrls,
    ofBacklog,
  }: Parameters<OpenItemRules['facts']>[0]): ReturnType<OpenItemRules['facts']> {
    return holdFacts(markHolders(openItems(run, documents, pasteUrls), documents, ofBacklog));
  }
}
