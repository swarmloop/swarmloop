import type { DeliveryEntry } from '../contract/delivery';
import type { DocumentRepository } from '../history/document.repository';
import { ARTIFACTS } from '../steps/contract/artifacts';
import { parseDelivery } from '../steps/contract/delivery-list';

/** The delivery list stored for a run, for a reader outside the steps. Null for a run made before the list existed: read it with `deliveryOf`. */
export async function storedDelivery(documents: DocumentRepository, key: string): Promise<DeliveryEntry[] | null> {
  const body = await documents.latestBody(key, ARTIFACTS.delivery.kind);
  return body?.trim() ? parseDelivery(body) : null;
}
