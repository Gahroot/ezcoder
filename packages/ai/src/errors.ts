export class GGAIError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GGAIError";
  }
}

export class ProviderError extends GGAIError {
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
