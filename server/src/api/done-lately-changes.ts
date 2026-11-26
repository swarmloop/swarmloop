import type { DoneLatelyItem } from '../contract/overview-done';

/** The Done lately items last sent to the sockets, so a change sends them only when they differ. */
export class DoneLatelyChanges {
  private sent: string | undefined;

  hasBaseline(): boolean {
    return this.sent !== undefined;
  }

  reset(items: DoneLatelyItem[]): void {
    this.sent = JSON.stringify(items);
  }

  /** The items when they differ from what was last sent, recorded as sent; else null. */
  since(items: DoneLatelyItem[]): DoneLatelyItem[] | null {
    if (JSON.stringify(items) === this.sent) {
      return null;
    }
    this.reset(items);
    return items;
  }
}
