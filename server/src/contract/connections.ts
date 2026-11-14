/** The kinds of flow a card offers: paste a secret, a CLI sign-in that asks for a code, a device code, a form of named fields, a sign-in on the provider's own page. */
export type ConnectionFlowKind = 'secret' | 'cli-code' | 'device-code' | 'form' | 'redirect';

export interface ConnectionFlowField {
  name: string;
  label: string;
  /** True for a field whose value is a secret: the dashboard hides it while typed and never shows it again. */
  secret: boolean;
}

export interface ConnectionFlow {
  kind: ConnectionFlowKind;
  label: string;
  /** The fields a `secret` or `form` flow asks for. */
  fields: ConnectionFlowField[];
  /** A page that helps with the flow, such as the page where a token is made. */
  helpUrl: string | null;
  /** Where a `redirect` flow sends the person. */
  url?: string;
}

/** One integration on the Connections page, as the dashboard draws it. It never holds a secret. */
export interface ConnectionCard {
  id: string;
  /** The key of the logo in the dashboard's logo map. */
  logo: string;
  label: string;
  /** What the integration is for, in plain words. */
  purpose: string;
  status: 'connected' | 'not-connected' | 'attention';
  /** The account the person is connected as, or null. */
  account: string | null;
  /** The last four characters of the stored secret, or null. */
  last4: string | null;
  /** Why the connection needs attention, or null. */
  reason: string | null;
  /** True when the server's own env holds a credential for this integration. */
  serverDefault: boolean;
  flows: ConnectionFlow[];
}

export interface IntegrationCardsView {
  cards: ConnectionCard[];
}

/** What a running CLI or device sign-in shows the person. */
export interface SignInView {
  id: string;
  state: 'waiting' | 'code' | 'done' | 'failed';
  /** The link the person opens, or null until the sign-in shows one. */
  link: string | null;
  /** The code to type in the dashboard or on the provider's page, or null. */
  code: string | null;
  /** The provider's message when the sign-in failed, or null. */
  message: string | null;
}
