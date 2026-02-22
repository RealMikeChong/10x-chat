/**
 * Exceptions for notebooklm.
 *
 * All library exceptions inherit from NotebookLMError.
 */

export class NotebookLMError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'NotebookLMError';
  }
}

export class ValidationError extends NotebookLMError {
  public constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class ConfigurationError extends NotebookLMError {
  public constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

export class NetworkError extends NotebookLMError {
  public readonly methodId: string | null;
  public readonly originalError: Error | null;

  public constructor(
    message: string,
    opts: {
      methodId?: string | null;
      originalError?: Error | null;
    } = {},
  ) {
    super(message);
    this.name = 'NetworkError';
    this.methodId = opts.methodId ?? null;
    this.originalError = opts.originalError ?? null;
  }
}

export class RPCError extends NotebookLMError {
  public readonly methodId: string | null;
  public rawResponse: string | null;
  public readonly rpcCode: string | number | null;
  public foundIds: string[];

  public constructor(
    message: string,
    opts: {
      methodId?: string | null;
      rawResponse?: string | null;
      rpcCode?: string | number | null;
      foundIds?: string[];
    } = {},
  ) {
    super(message);
    this.name = 'RPCError';
    this.methodId = opts.methodId ?? null;
    this.rawResponse = opts.rawResponse ? opts.rawResponse.slice(0, 500) : null;
    this.rpcCode = opts.rpcCode ?? null;
    this.foundIds = opts.foundIds ?? [];
  }

  public get rpcId(): string | null {
    console.warn("The 'rpcId' property is deprecated, use 'methodId' instead.");
    return this.methodId;
  }

  public get code(): string | number | null {
    console.warn("The 'code' property is deprecated, use 'rpcCode' instead.");
    return this.rpcCode;
  }
}

export class DecodingError extends RPCError {
  public constructor(
    message: string,
    opts: {
      methodId?: string | null;
      rawResponse?: string | null;
      rpcCode?: string | number | null;
      foundIds?: string[];
    } = {},
  ) {
    super(message, opts);
    this.name = 'DecodingError';
  }
}

export class UnknownRPCMethodError extends DecodingError {
  public constructor(
    message: string,
    opts: {
      methodId?: string | null;
      rawResponse?: string | null;
      rpcCode?: string | number | null;
      foundIds?: string[];
    } = {},
  ) {
    super(message, opts);
    this.name = 'UnknownRPCMethodError';
  }
}

export class AuthError extends RPCError {
  public readonly recoverable: boolean;

  public constructor(
    message: string,
    opts: {
      recoverable?: boolean;
      methodId?: string | null;
      rawResponse?: string | null;
      rpcCode?: string | number | null;
      foundIds?: string[];
    } = {},
  ) {
    super(message, opts);
    this.name = 'AuthError';
    this.recoverable = opts.recoverable ?? false;
  }
}

export class RateLimitError extends RPCError {
  public readonly retryAfter: number | null;

  public constructor(
    message: string,
    opts: {
      retryAfter?: number | null;
      methodId?: string | null;
      rawResponse?: string | null;
      rpcCode?: string | number | null;
      foundIds?: string[];
    } = {},
  ) {
    super(message, opts);
    this.name = 'RateLimitError';
    this.retryAfter = opts.retryAfter ?? null;
  }
}

export class ServerError extends RPCError {
  public readonly statusCode: number | null;

  public constructor(
    message: string,
    opts: {
      statusCode?: number | null;
      methodId?: string | null;
      rawResponse?: string | null;
      rpcCode?: string | number | null;
      foundIds?: string[];
    } = {},
  ) {
    super(message, opts);
    this.name = 'ServerError';
    this.statusCode = opts.statusCode ?? null;
  }
}

export class ClientError extends RPCError {
  public readonly statusCode: number | null;

  public constructor(
    message: string,
    opts: {
      statusCode?: number | null;
      methodId?: string | null;
      rawResponse?: string | null;
      rpcCode?: string | number | null;
      foundIds?: string[];
    } = {},
  ) {
    super(message, opts);
    this.name = 'ClientError';
    this.statusCode = opts.statusCode ?? null;
  }
}

export class RPCTimeoutError extends NetworkError {
  public readonly timeoutSeconds: number | null;

  public constructor(
    message: string,
    opts: {
      timeoutSeconds?: number | null;
      methodId?: string | null;
      originalError?: Error | null;
    } = {},
  ) {
    super(message, opts);
    this.name = 'RPCTimeoutError';
    this.timeoutSeconds = opts.timeoutSeconds ?? null;
  }
}

export class NotebookError extends NotebookLMError {
  public constructor(message: string) {
    super(message);
    this.name = 'NotebookError';
  }
}

export class NotebookNotFoundError extends NotebookError {
  public readonly notebookId: string;

  public constructor(notebookId: string) {
    super(`Notebook not found: ${notebookId}`);
    this.name = 'NotebookNotFoundError';
    this.notebookId = notebookId;
  }
}

export class ChatError extends NotebookLMError {
  public constructor(message: string) {
    super(message);
    this.name = 'ChatError';
  }
}

export class SourceError extends NotebookLMError {
  public constructor(message: string) {
    super(message);
    this.name = 'SourceError';
  }
}

export class SourceAddError extends SourceError {
  public readonly url: string;
  public readonly cause: Error | null;

  public constructor(url: string, opts: { cause?: Error | null; message?: string } = {}) {
    const message =
      opts.message ??
      [
        `Failed to add source: ${url}`,
        'Possible causes:',
        '  - URL is invalid or inaccessible',
        '  - Content is behind a paywall or requires authentication',
        '  - Page content is empty or could not be parsed',
        '  - Rate limiting or quota exceeded',
      ].join('\n');

    super(message);
    this.name = 'SourceAddError';
    this.url = url;
    this.cause = opts.cause ?? null;
  }
}

export class SourceNotFoundError extends SourceError {
  public readonly sourceId: string;

  public constructor(sourceId: string) {
    super(`Source not found: ${sourceId}`);
    this.name = 'SourceNotFoundError';
    this.sourceId = sourceId;
  }
}

export class SourceProcessingError extends SourceError {
  public readonly sourceId: string;
  public readonly status: number;

  public constructor(sourceId: string, status = 3, message = '') {
    super(message || `Source ${sourceId} failed to process`);
    this.name = 'SourceProcessingError';
    this.sourceId = sourceId;
    this.status = status;
  }
}

export class SourceTimeoutError extends SourceError {
  public readonly sourceId: string;
  public readonly timeout: number;
  public readonly lastStatus: number | null;

  public constructor(sourceId: string, timeout: number, lastStatus: number | null = null) {
    const statusInfo = lastStatus === null ? '' : ` (last status: ${lastStatus})`;
    super(`Source ${sourceId} not ready after ${timeout.toFixed(1)}s${statusInfo}`);
    this.name = 'SourceTimeoutError';
    this.sourceId = sourceId;
    this.timeout = timeout;
    this.lastStatus = lastStatus;
  }
}

export class ArtifactError extends NotebookLMError {
  public constructor(message: string) {
    super(message);
    this.name = 'ArtifactError';
  }
}

export class ArtifactNotFoundError extends ArtifactError {
  public readonly artifactId: string;
  public readonly artifactType: string | null;

  public constructor(artifactId: string, artifactType: string | null = null) {
    const typePrefix = artifactType
      ? `${artifactType.charAt(0).toUpperCase()}${artifactType.slice(1)} `
      : '';
    super(`${typePrefix}artifact ${artifactId} not found`);
    this.name = 'ArtifactNotFoundError';
    this.artifactId = artifactId;
    this.artifactType = artifactType;
  }
}

export class ArtifactNotReadyError extends ArtifactError {
  public readonly artifactType: string;
  public readonly artifactId: string | null;
  public readonly status: string | null;

  public constructor(
    artifactType: string,
    opts: { artifactId?: string | null; status?: string | null } = {},
  ) {
    const artifactId = opts.artifactId ?? null;
    const status = opts.status ?? null;
    let message = `No completed ${artifactType} found`;
    if (artifactId) {
      message = `${artifactType.charAt(0).toUpperCase()}${artifactType.slice(1)} artifact ${artifactId} is not ready`;
      if (status) {
        message += ` (status: ${status})`;
      }
    }

    super(message);
    this.name = 'ArtifactNotReadyError';
    this.artifactType = artifactType;
    this.artifactId = artifactId;
    this.status = status;
  }
}

export class ArtifactParseError extends ArtifactError {
  public readonly artifactType: string;
  public readonly artifactId: string | null;
  public readonly details: string | null;
  public readonly cause: Error | null;

  public constructor(
    artifactType: string,
    opts: {
      details?: string | null;
      artifactId?: string | null;
      cause?: Error | null;
    } = {},
  ) {
    const artifactId = opts.artifactId ?? null;
    const details = opts.details ?? null;

    let message = `Failed to parse ${artifactType} artifact`;
    if (artifactId) {
      message += ` ${artifactId}`;
    }
    if (details) {
      message += `: ${details}`;
    }

    super(message);
    this.name = 'ArtifactParseError';
    this.artifactType = artifactType;
    this.artifactId = artifactId;
    this.details = details;
    this.cause = opts.cause ?? null;
  }
}

export class ArtifactDownloadError extends ArtifactError {
  public readonly artifactType: string;
  public readonly artifactId: string | null;
  public readonly details: string | null;
  public readonly cause: Error | null;

  public constructor(
    artifactType: string,
    opts: {
      details?: string | null;
      artifactId?: string | null;
      cause?: Error | null;
    } = {},
  ) {
    const artifactId = opts.artifactId ?? null;
    const details = opts.details ?? null;

    let message = `Failed to download ${artifactType} artifact`;
    if (artifactId) {
      message += ` ${artifactId}`;
    }
    if (details) {
      message += `: ${details}`;
    }

    super(message);
    this.name = 'ArtifactDownloadError';
    this.artifactType = artifactType;
    this.artifactId = artifactId;
    this.details = details;
    this.cause = opts.cause ?? null;
  }
}

export enum RPCErrorCode {
  UNKNOWN = 0,
  INVALID_REQUEST = 400,
  UNAUTHORIZED = 401,
  FORBIDDEN = 403,
  NOT_FOUND = 404,
  RATE_LIMITED = 429,
  SERVER_ERROR = 500,
}

const ERROR_CODE_MESSAGES: Record<number, { message: string; retryable: boolean }> = {
  [RPCErrorCode.INVALID_REQUEST]: {
    message: 'Invalid request parameters. Check your input and try again.',
    retryable: false,
  },
  [RPCErrorCode.UNAUTHORIZED]: {
    message: 'Authentication required. Re-authenticate and retry.',
    retryable: false,
  },
  [RPCErrorCode.FORBIDDEN]: {
    message: 'Insufficient permissions for this operation.',
    retryable: false,
  },
  [RPCErrorCode.NOT_FOUND]: {
    message: 'Requested resource not found.',
    retryable: false,
  },
  [RPCErrorCode.RATE_LIMITED]: {
    message: 'API rate limit exceeded. Please wait before retrying.',
    retryable: true,
  },
  [RPCErrorCode.SERVER_ERROR]: {
    message: 'Server error occurred. This is usually temporary - try again later.',
    retryable: true,
  },
};

export function getErrorMessageForCode(code: number | null | undefined): {
  message: string;
  retryable: boolean;
} {
  if (code === null || code === undefined) {
    return { message: 'Unknown error occurred.', retryable: false };
  }

  const mapped = ERROR_CODE_MESSAGES[code];
  if (mapped) {
    return mapped;
  }

  if (code >= 400 && code < 500) {
    return { message: `Client error ${code}. Check your request parameters.`, retryable: false };
  }

  if (code >= 500 && code < 600) {
    return {
      message: `Server error ${code}. This is usually temporary - try again later.`,
      retryable: true,
    };
  }

  return { message: `Error code: ${code}`, retryable: false };
}
