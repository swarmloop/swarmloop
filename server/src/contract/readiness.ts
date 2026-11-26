export type ReadinessId =
  'docker' | 'arch' | 'images' | 'disk' | 'paths' | 'ports' | 'model-credential' | 'code-host-token' | 'stalls';

export interface ReadinessItem {
  id: ReadinessId;
  status: 'ok' | 'warn' | 'fail';
  /** One line that says what was found. */
  line: string;
  /** The few words a tile shows, cut by the server from what it found. */
  short: string;
  /** Only on the `disk` item: what swarmloop itself uses, with the age of the measure, or that sizes are not measured yet. */
  ownUse?: string;
  /** One next step. For an `ok` item it says there is nothing to do. */
  action: string;
  /** The dashboard page that fixes the item, such as the card of a connection. */
  link?: string;
}

export interface ReadinessView {
  items: ReadinessItem[];
  /** When the report was built; null while the first one is still being built. */
  checkedAt: string | null;
}
