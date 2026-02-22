import {
  AuthError,
  ClientError,
  getErrorMessageForCode,
  NetworkError,
  RateLimitError,
  RPCError,
  RPCErrorCode,
  RPCTimeoutError,
  ServerError,
} from '../errors.js';

export {
  AuthError,
  ClientError,
  NetworkError,
  RPCError,
  RPCErrorCode,
  RPCTimeoutError,
  RateLimitError,
  ServerError,
};

export function stripAntiXssi(response: string): string {
  if (response.startsWith(")]}'")) {
    const match = /^\)\]\}'\r?\n/.exec(response);
    if (match) {
      return response.slice(match[0].length);
    }
  }
  return response;
}

export function parseChunkedResponse(response: string): unknown[] {
  if (!response || response.trim().length === 0) {
    return [];
  }

  const chunks: unknown[] = [];
  let skippedCount = 0;
  const lines = response.trim().split('\n');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]?.trim() ?? '';

    if (!line) {
      i += 1;
      continue;
    }

    const byteCount = Number(line);
    if (Number.isInteger(byteCount)) {
      i += 1;
      if (i < lines.length) {
        const jsonStr = lines[i] ?? '';
        try {
          chunks.push(JSON.parse(jsonStr));
        } catch (error) {
          skippedCount += 1;
          console.warn(
            `Skipping malformed chunk at line ${i + 1}: ${String(error)}. Preview: ${jsonStr.slice(0, 100)}`,
          );
        }
      }
      i += 1;
      continue;
    }

    try {
      chunks.push(JSON.parse(line));
    } catch (error) {
      skippedCount += 1;
      console.warn(
        `Skipping non-JSON line at ${i + 1}: ${String(error)}. Preview: ${line.slice(0, 100)}`,
      );
    }

    i += 1;
  }

  if (skippedCount > 0) {
    const errorRate = lines.length === 0 ? 0 : skippedCount / lines.length;
    if (errorRate > 0.1) {
      throw new RPCError(
        `Response parsing failed: ${skippedCount} of ${lines.length} chunks malformed. This may indicate API changes or data corruption.`,
        { rawResponse: response.slice(0, 500) },
      );
    }

    console.warn(
      `Parsed response but skipped ${skippedCount} malformed chunks (${Math.trunc(errorRate * 100)}%). Results may be incomplete.`,
    );
  }

  return chunks;
}

export function collectRpcIds(chunks: unknown[]): string[] {
  const foundIds: string[] = [];

  for (const chunk of chunks) {
    if (!Array.isArray(chunk)) {
      continue;
    }

    const items = chunk.length > 0 && Array.isArray(chunk[0]) ? (chunk as unknown[]) : [chunk];

    for (const item of items) {
      if (!Array.isArray(item) || item.length < 2) {
        continue;
      }

      const kind = item[0];
      const id = item[1];
      if ((kind === 'wrb.fr' || kind === 'er') && typeof id === 'string') {
        foundIds.push(id);
      }
    }
  }

  return foundIds;
}

function containsUserDisplayableError(obj: unknown): boolean {
  if (typeof obj === 'string') {
    return obj.includes('UserDisplayableError');
  }

  if (Array.isArray(obj)) {
    return obj.some((item) => containsUserDisplayableError(item));
  }

  if (obj && typeof obj === 'object') {
    return Object.values(obj).some((value) => containsUserDisplayableError(value));
  }

  return false;
}

export function extractRpcResult(chunks: unknown[], rpcId: string): unknown {
  for (const chunk of chunks) {
    if (!Array.isArray(chunk)) {
      continue;
    }

    const items = chunk.length > 0 && Array.isArray(chunk[0]) ? (chunk as unknown[]) : [chunk];

    for (const item of items) {
      if (!Array.isArray(item) || item.length < 3) {
        continue;
      }

      if (item[0] === 'er' && item[1] === rpcId) {
        const errorCode = item.length > 2 ? item[2] : null;

        let errorMessage = 'Unknown error';
        if (typeof errorCode === 'number') {
          const { message, retryable } = getErrorMessageForCode(errorCode);
          console.debug(
            `RPC error code ${errorCode} for ${rpcId}: ${message} (retryable: ${String(retryable)})`,
          );
          errorMessage = message;
        } else if (errorCode !== null && errorCode !== undefined) {
          errorMessage = String(errorCode);
        }

        throw new RPCError(errorMessage, {
          methodId: rpcId,
          rpcCode:
            typeof errorCode === 'string' || typeof errorCode === 'number' ? errorCode : null,
        });
      }

      if (item[0] === 'wrb.fr' && item[1] === rpcId) {
        const resultData = item[2];

        if (resultData === null && item.length > 5 && item[5] !== null) {
          if (containsUserDisplayableError(item[5])) {
            throw new RateLimitError(
              'API rate limit or quota exceeded. Please wait before retrying.',
              {
                methodId: rpcId,
                rpcCode: 'USER_DISPLAYABLE_ERROR',
              },
            );
          }
        }

        if (typeof resultData === 'string') {
          try {
            return JSON.parse(resultData);
          } catch {
            return resultData;
          }
        }

        return resultData;
      }
    }
  }

  return null;
}

export function decodeResponse(rawResponse: string, rpcId: string, allowNull = false): unknown {
  console.debug(`Decoding response: size=${rawResponse.length} bytes`);
  const cleaned = stripAntiXssi(rawResponse);
  const chunks = parseChunkedResponse(cleaned);
  console.debug(`Parsed ${chunks.length} chunks from response`);

  const responsePreview = cleaned.length > 500 ? cleaned.slice(0, 500) : cleaned;
  const foundIds = collectRpcIds(chunks);

  console.debug(`Looking for RPC ID: ${rpcId}`);
  console.debug(`Found RPC IDs in response: ${JSON.stringify(foundIds)}`);

  let result: unknown;
  try {
    result = extractRpcResult(chunks, rpcId);
  } catch (error) {
    if (error instanceof RPCError) {
      if (error.foundIds.length === 0) {
        error.foundIds = foundIds;
      }
      if (!error.rawResponse) {
        error.rawResponse = responsePreview;
      }
    }
    throw error;
  }

  if (result === null && !allowNull) {
    if (foundIds.length > 0 && !foundIds.includes(rpcId)) {
      throw new RPCError(
        `No result found for RPC ID '${rpcId}'. Response contains IDs: ${JSON.stringify(foundIds)}. The RPC method ID may have changed.`,
        {
          methodId: rpcId,
          foundIds,
          rawResponse: responsePreview,
        },
      );
    }

    console.debug(
      `Empty result for RPC ID '${rpcId}'. Chunks parsed: ${chunks.length}. Response preview: ${responsePreview}`,
    );

    throw new RPCError(`No result found for RPC ID: ${rpcId}`, {
      methodId: rpcId,
      rawResponse: responsePreview,
    });
  }

  return result;
}
