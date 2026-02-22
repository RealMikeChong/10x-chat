import type { ClientCore } from '../core.js';
import { ValidationError } from '../errors.js';
import { RPCMethod } from '../rpc/types.js';

export class ResearchAPI {
  private readonly core: ClientCore;

  public constructor(core: ClientCore) {
    this.core = core;
  }

  public async start(
    notebookId: string,
    query: string,
    source = 'web',
    mode = 'fast',
  ): Promise<Record<string, unknown> | null> {
    console.debug(`Starting ${mode} research in notebook ${notebookId}: ${query.slice(0, 50)}`);

    const sourceLower = source.toLowerCase();
    const modeLower = mode.toLowerCase();

    if (sourceLower !== 'web' && sourceLower !== 'drive') {
      throw new ValidationError(`Invalid source '${source}'. Use 'web' or 'drive'.`);
    }

    if (modeLower !== 'fast' && modeLower !== 'deep') {
      throw new ValidationError(`Invalid mode '${mode}'. Use 'fast' or 'deep'.`);
    }

    if (modeLower === 'deep' && sourceLower === 'drive') {
      throw new ValidationError('Deep Research only supports Web sources.');
    }

    const sourceType = sourceLower === 'web' ? 1 : 2;

    let params: unknown[];
    let rpcId: RPCMethod;

    if (modeLower === 'fast') {
      params = [[query, sourceType], null, 1, notebookId];
      rpcId = RPCMethod.START_FAST_RESEARCH;
    } else {
      params = [null, [1], [query, sourceType], 5, notebookId];
      rpcId = RPCMethod.START_DEEP_RESEARCH;
    }

    const result = await this.core.rpcCall(rpcId, params, `/notebook/${notebookId}`);

    if (Array.isArray(result) && result.length > 0) {
      const taskId = result[0];
      const reportId = result.length > 1 ? result[1] : null;

      return {
        taskId,
        reportId,
        notebookId,
        query,
        mode: modeLower,
      };
    }

    return null;
  }

  public async poll(notebookId: string): Promise<Record<string, unknown>> {
    console.debug(`Polling research status for notebook ${notebookId}`);
    const params = [null, null, notebookId];
    const raw = await this.core.rpcCall(RPCMethod.POLL_RESEARCH, params, `/notebook/${notebookId}`);

    if (!Array.isArray(raw) || raw.length === 0) {
      return { status: 'no_research' };
    }

    let result = raw;
    if (Array.isArray(result[0]) && result[0].length > 0 && Array.isArray(result[0][0])) {
      result = result[0] as unknown[];
    }

    for (const taskData of result) {
      if (!Array.isArray(taskData) || taskData.length < 2) {
        continue;
      }

      const taskId = taskData[0];
      const taskInfo = taskData[1];
      if (typeof taskId !== 'string' || !Array.isArray(taskInfo)) {
        continue;
      }

      const queryInfo = taskInfo.length > 1 ? taskInfo[1] : null;
      const sourcesAndSummary = taskInfo.length > 3 ? taskInfo[3] : [];
      const statusCode = taskInfo.length > 4 ? taskInfo[4] : null;

      const queryText =
        Array.isArray(queryInfo) && typeof queryInfo[0] === 'string' ? queryInfo[0] : '';

      let sourcesData: unknown[] = [];
      let summary = '';
      if (Array.isArray(sourcesAndSummary) && sourcesAndSummary.length >= 1) {
        if (Array.isArray(sourcesAndSummary[0])) {
          sourcesData = sourcesAndSummary[0];
        }

        if (sourcesAndSummary.length >= 2 && typeof sourcesAndSummary[1] === 'string') {
          summary = sourcesAndSummary[1];
        }
      }

      const parsedSources: Array<{ url: string; title: string }> = [];
      for (const src of sourcesData) {
        if (!Array.isArray(src) || src.length < 2) {
          continue;
        }

        let title = '';
        let url = '';

        if (src[0] === null && src.length > 1 && typeof src[1] === 'string') {
          title = src[1];
          url = '';
        } else if (typeof src[0] === 'string' || src.length >= 3) {
          url = typeof src[0] === 'string' ? src[0] : '';
          title = src.length > 1 && typeof src[1] === 'string' ? src[1] : '';
        }

        if (title || url) {
          parsedSources.push({ url, title });
        }
      }

      const status = statusCode === 2 ? 'completed' : 'in_progress';

      return {
        taskId,
        status,
        query: queryText,
        sources: parsedSources,
        summary,
      };
    }

    return { status: 'no_research' };
  }

  public async importSources(
    notebookId: string,
    taskId: string,
    sources: Array<Record<string, string>>,
  ): Promise<Array<{ id: string; title: string }>> {
    console.debug(`Importing ${sources.length} research sources into notebook ${notebookId}`);
    if (sources.length === 0) {
      return [];
    }

    const validSources = sources.filter((source) => Boolean(source.url));
    const skippedCount = sources.length - validSources.length;
    if (skippedCount > 0) {
      console.warn(`Skipping ${skippedCount} source(s) without URLs (cannot be imported)`);
    }

    if (validSources.length === 0) {
      return [];
    }

    const sourceArray = validSources.map((source) => [
      null,
      null,
      [source.url, source.title ?? 'Untitled'],
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      2,
    ]);

    const params = [null, [1], taskId, notebookId, sourceArray];
    const raw = await this.core.rpcCall(
      RPCMethod.IMPORT_RESEARCH,
      params,
      `/notebook/${notebookId}`,
    );

    const imported: Array<{ id: string; title: string }> = [];
    if (Array.isArray(raw)) {
      let result = raw;
      if (
        result.length > 0 &&
        Array.isArray(result[0]) &&
        result[0].length > 0 &&
        Array.isArray(result[0][0])
      ) {
        result = result[0] as unknown[];
      }

      for (const srcData of result) {
        if (!Array.isArray(srcData) || srcData.length < 2) {
          continue;
        }

        const sourceIdWrap = srcData[0];
        const sourceId =
          Array.isArray(sourceIdWrap) &&
          sourceIdWrap.length > 0 &&
          typeof sourceIdWrap[0] === 'string'
            ? sourceIdWrap[0]
            : null;

        if (sourceId) {
          imported.push({
            id: sourceId,
            title: typeof srcData[1] === 'string' ? srcData[1] : '',
          });
        }
      }
    }

    return imported;
  }
}
