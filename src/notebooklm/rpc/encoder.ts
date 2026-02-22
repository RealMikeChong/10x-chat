import type { RPCMethod } from './types.js';

/**
 * Encode an RPC request into batchexecute format.
 *
 * Format: `[[[rpc_id, json_params, null, "generic"]]]`
 */
export function encodeRpcRequest(method: RPCMethod, params: unknown[]): unknown[] {
  const paramsJson = JSON.stringify(params);
  const inner = [method, paramsJson, null, 'generic'];
  return [[inner]];
}

/** Build form-encoded request body for batchexecute. */
export function buildRequestBody(
  rpcRequest: unknown[],
  csrfToken?: string | null,
  _sessionId?: string | null,
): string {
  const fReq = JSON.stringify(rpcRequest);
  const parts = [`f.req=${encodeURIComponent(fReq)}`];

  if (csrfToken) {
    parts.push(`at=${encodeURIComponent(csrfToken)}`);
  }

  return `${parts.join('&')}&`;
}

/** Build URL query parameters for batchexecute requests. */
export function buildUrlParams(
  rpcMethod: RPCMethod,
  sourcePath = '/',
  sessionId?: string | null,
  bl?: string | null,
): Record<string, string> {
  const params: Record<string, string> = {
    rpcids: rpcMethod,
    'source-path': sourcePath,
    hl: 'en',
    rt: 'c',
  };

  if (sessionId) {
    params['f.sid'] = sessionId;
  }

  if (bl) {
    params.bl = bl;
  }

  return params;
}
