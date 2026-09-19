export type Wire = 'openai-chat' | 'anthropic-messages' | 'openai-responses';
export type AuthMethod = 'oauth' | 'api_key' | 'none';

export type Credential =
  | { type: 'api_key'; key: string }
  | { type: 'oauth'; access: string; refresh?: string; expires?: number; account?: string }
  | { type: 'none' };

export interface ModelRow { id: string; temperature?: number }

export interface OAuthDescriptor {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes: string[];
  redirect: 'loopback' | 'paste';
  port?: number;
  callbackPath: string;
  state: boolean;
  exchange: 'token' | 'key';
  wire?: Wire;
  baseUrl?: string;
  discover?: boolean;
}

export interface ProviderSpec {
  id: string;
  name: string;
  baseUrl: string;
  wire: Wire;
  discover: boolean;
  auth: AuthMethod[];
  models: ModelRow[];
  oauth?: OAuthDescriptor;
}

export interface Completion { text: string; truncated: boolean }

export interface ProposalRequest {
  kind: 'file' | 'text';
  objective: string;
  constraints: string;
  count: number;
  path?: string;
  current?: string;
}

/** generate rejects only with already-scrubbed messages; callers may surface them as-is. */
export interface ProposalProvider {
  id: string;
  model: string;
  generate(req: ProposalRequest, signal: AbortSignal): Promise<Completion[]>;
}

export interface ProviderIo {
  out: NodeJS.WriteStream;
  stdin: NodeJS.ReadStream;
  open?: (url: string) => Promise<void>;
}

export interface ProviderAuth {
  login(io: ProviderIo): Promise<void>;
  logout(): Promise<void>;
  credential(): Promise<Credential | undefined>;
}
