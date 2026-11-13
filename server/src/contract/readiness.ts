export type ReadinessId =
  'docker' | 'arch' | 'images' | 'disk' | 'paths' | 'ports' | 'model-credential' | 'code-host-token';

export interface ReadinessItem {
  id: ReadinessId;
  status: 'ok' | 'warn' | 'fail';
  /** One line that says what was found. */
  line: string;
  /** One next step. For an `ok` item it says there is nothing to do. */
  action: string;
}

export interface ReadinessView {
  items: ReadinessItem[];
  /** When the report was built; null while the first one is still being built. */
  checkedAt: string | null;
}
