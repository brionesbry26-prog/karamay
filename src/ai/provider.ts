export interface AiTurn {
  role: 'user' | 'model';
  text: string;
}

export interface AiRequest {
  system: string;
  turns: AiTurn[];
  maxOutputTokens: number;
}

export interface AiUsage {
  inputTokens: number;
  /** Visible output plus thinking tokens (both are billed as output). */
  outputTokens: number;
}

export interface AiResult {
  text: string | null;
  /** Set when the provider refused to answer (safety filter or policy). */
  blocked: 'prompt' | 'response' | null;
  finishReason: string | null;
  usage: AiUsage | null;
}

export type AiErrorKind =
  | 'timeout'
  | 'rate_limited'
  | 'unavailable'
  | 'auth'
  | 'model_not_found'
  | 'bad_request'
  | 'malformed_response'
  | 'unknown';

/** Provider failure with a classified kind. The message never contains provider payloads or secrets. */
export class AiProviderError extends Error {
  constructor(
    public readonly kind: AiErrorKind,
    public readonly status?: number,
  ) {
    super(`ai provider error: ${kind}`);
    this.name = 'AiProviderError';
  }

  get retryable(): boolean {
    // Timeouts are not retried: the provider may still bill an aborted call.
    return this.kind === 'rate_limited' || this.kind === 'unavailable';
  }
}

export interface AiProvider {
  readonly model: string;
  generate(req: AiRequest): Promise<AiResult>;
}
