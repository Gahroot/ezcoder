export class EZCoderAIError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EZCoderAIError";
  }
}

export class ProviderError extends EZCoderAIError {
  readonly provider: string;
  readonly statusCode?: number;

  constructor(
    provider: string,
    message: string,
    options?: { statusCode?: number; cause?: unknown },
  ) {
    super(`[${provider}] ${message}`, { cause: options?.cause });
    this.name = "ProviderError";
    this.provider = provider;
    this.statusCode = options?.statusCode;
  }
}
