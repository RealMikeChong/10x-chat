import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ClientCore } from '../core.js';
import {
  RPCError,
  SourceAddError,
  SourceNotFoundError,
  SourceProcessingError,
  SourceTimeoutError,
  ValidationError,
} from '../errors.js';
import { RPCMethod, SourceStatus, UPLOAD_URL } from '../rpc/types.js';
import {
  createSourceFulltext,
  Source,
  type SourceFulltext,
  type Source as SourceType,
} from '../types.js';

function isYouTubeUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return (
      hostname === 'youtube.com' || hostname.endsWith('.youtube.com') || hostname === 'youtu.be'
    );
  } catch {
    return false;
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export class SourcesAPI {
  private readonly core: ClientCore;

  public constructor(core: ClientCore) {
    this.core = core;
  }

  public async list(notebookId: string): Promise<SourceType[]> {
    const params = [notebookId, null, [2], null, 0];
    const notebook = await this.core.rpcCall(
      RPCMethod.GET_NOTEBOOK,
      params,
      `/notebook/${notebookId}`,
    );

    if (!Array.isArray(notebook) || notebook.length === 0) {
      console.warn(
        `Empty or invalid notebook response when listing sources for ${notebookId} (API response structure may have changed)`,
      );
      return [];
    }

    const notebookInfo = notebook[0];
    if (!Array.isArray(notebookInfo) || notebookInfo.length <= 1) {
      console.warn(
        `Unexpected notebook structure for ${notebookId}: expected list with sources at index 1 (API structure may have changed)`,
      );
      return [];
    }

    const sourcesList = notebookInfo[1];
    if (!Array.isArray(sourcesList)) {
      console.warn(
        `Sources data for ${notebookId} is not a list (type=${typeof sourcesList}), returning empty list (API structure may have changed)`,
      );
      return [];
    }

    const sources: SourceType[] = [];

    for (const src of sourcesList) {
      if (!Array.isArray(src) || src.length === 0) {
        continue;
      }

      const sourceIdRaw = Array.isArray(src[0]) ? src[0][0] : src[0];
      const sourceId = typeof sourceIdRaw === 'string' ? sourceIdRaw : String(sourceIdRaw ?? '');
      const title = typeof src[1] === 'string' ? src[1] : null;

      let url: string | null = null;
      if (
        Array.isArray(src[2]) &&
        src[2].length > 7 &&
        Array.isArray(src[2][7]) &&
        src[2][7].length > 0
      ) {
        url = typeof src[2][7][0] === 'string' ? src[2][7][0] : null;
      }

      let createdAt: Date | null = null;
      if (
        Array.isArray(src[2]) &&
        src[2].length > 2 &&
        Array.isArray(src[2][2]) &&
        src[2][2].length > 0
      ) {
        const ts = src[2][2][0];
        if (typeof ts === 'number') {
          createdAt = new Date(ts * 1000);
        }
      }

      let status = SourceStatus.READY;
      if (Array.isArray(src[3]) && src[3].length > 1) {
        const statusCode = src[3][1];
        if (
          statusCode === SourceStatus.PROCESSING ||
          statusCode === SourceStatus.READY ||
          statusCode === SourceStatus.ERROR ||
          statusCode === SourceStatus.PREPARING
        ) {
          status = statusCode;
        }
      }

      let typeCode: number | null = null;
      if (Array.isArray(src[2]) && src[2].length > 4 && typeof src[2][4] === 'number') {
        typeCode = src[2][4];
      }

      sources.push(
        Source.fromApiResponse([
          [sourceId],
          title,
          [null, null, null, null, typeCode, null, null, url ? [url] : []],
          [null, status],
        ]),
      );

      const last = sources[sources.length - 1];
      // Preserve created timestamp from list() path where it is available.
      if (last) {
        last.createdAt = createdAt;
        last.status = status;
        last.isReady = status === SourceStatus.READY;
        last.isProcessing = status === SourceStatus.PROCESSING;
        last.isError = status === SourceStatus.ERROR;
      }
    }

    return sources;
  }

  public async get(notebookId: string, sourceId: string): Promise<SourceType | null> {
    const sources = await this.list(notebookId);
    return sources.find((source) => source.id === sourceId) ?? null;
  }

  public async waitUntilReady(
    notebookId: string,
    sourceId: string,
    timeout = 120,
    initialInterval = 1,
    maxInterval = 10,
    backoffFactor = 1.5,
  ): Promise<SourceType> {
    const start = performance.now();
    let interval = initialInterval;
    let lastStatus: number | null = null;

    while (true) {
      const elapsed = (performance.now() - start) / 1000;
      if (elapsed >= timeout) {
        throw new SourceTimeoutError(sourceId, timeout, lastStatus);
      }

      const source = await this.get(notebookId, sourceId);
      if (!source) {
        throw new SourceNotFoundError(sourceId);
      }

      lastStatus = source.status;

      if (source.isReady) {
        return source;
      }

      if (source.isError) {
        throw new SourceProcessingError(sourceId, source.status);
      }

      const remaining = timeout - (performance.now() - start) / 1000;
      if (remaining <= 0) {
        throw new SourceTimeoutError(sourceId, timeout, lastStatus);
      }

      const sleepTime = Math.min(interval, remaining);
      await sleep(Math.max(1, Math.floor(sleepTime * 1000)));
      interval = Math.min(interval * backoffFactor, maxInterval);
    }
  }

  public async waitForSources(
    notebookId: string,
    sourceIds: string[],
    timeout = 120,
    opts: {
      initialInterval?: number;
      maxInterval?: number;
      backoffFactor?: number;
    } = {},
  ): Promise<SourceType[]> {
    const tasks = sourceIds.map((sourceId) =>
      this.waitUntilReady(
        notebookId,
        sourceId,
        timeout,
        opts.initialInterval,
        opts.maxInterval,
        opts.backoffFactor,
      ),
    );

    return Promise.all(tasks);
  }

  public async addUrl(
    notebookId: string,
    url: string,
    wait = false,
    waitTimeout = 120,
  ): Promise<SourceType> {
    console.debug(`Adding URL source to notebook ${notebookId}: ${url.slice(0, 80)}`);

    const videoId = this.extractYouTubeVideoId(url);
    let result: unknown;

    try {
      if (videoId) {
        result = await this.addYouTubeSource(notebookId, url);
      } else {
        if (isYouTubeUrl(url)) {
          console.warn(
            `URL appears to be YouTube but no video ID found: ${url.slice(0, 100)}. Adding as web page.`,
          );
        }
        result = await this.addUrlSource(notebookId, url);
      }
    } catch (error) {
      if (error instanceof RPCError) {
        throw new SourceAddError(url, { cause: error });
      }
      throw error;
    }

    if (!Array.isArray(result)) {
      throw new SourceAddError(url, { message: `API returned no data for URL: ${url}` });
    }

    const source = Source.fromApiResponse(result);
    if (wait) {
      return this.waitUntilReady(notebookId, source.id, waitTimeout);
    }

    return source;
  }

  public async addText(
    notebookId: string,
    title: string,
    content: string,
    wait = false,
    waitTimeout = 120,
  ): Promise<SourceType> {
    console.debug(`Adding text source to notebook ${notebookId}: ${title}`);
    const params = [
      [[null, [title, content], null, null, null, null, null, null]],
      notebookId,
      [2],
      null,
      null,
    ];

    let result: unknown;
    try {
      result = await this.core.rpcCall(RPCMethod.ADD_SOURCE, params, `/notebook/${notebookId}`);
    } catch (error) {
      if (error instanceof RPCError) {
        throw new SourceAddError(title, {
          cause: error,
          message: `Failed to add text source '${title}'`,
        });
      }
      throw error;
    }

    if (!Array.isArray(result)) {
      throw new SourceAddError(title, {
        message: `API returned no data for text source: ${title}`,
      });
    }

    const source = Source.fromApiResponse(result);
    if (wait) {
      return this.waitUntilReady(notebookId, source.id, waitTimeout);
    }

    return source;
  }

  public async addFile(
    notebookId: string,
    filePath: string,
    _mimeType?: string,
    wait = false,
    waitTimeout = 120,
  ): Promise<SourceType> {
    console.debug(`Adding file source to notebook ${notebookId}: ${filePath}`);

    const resolved = path.resolve(filePath);
    let fileInfo: Awaited<ReturnType<typeof stat>>;
    try {
      fileInfo = await stat(resolved);
    } catch {
      throw new Error(`File not found: ${resolved}`);
    }

    if (!fileInfo.isFile()) {
      throw new ValidationError(`Not a regular file: ${resolved}`);
    }

    const filename = path.basename(resolved);
    const fileSize = fileInfo.size;

    const sourceId = await this.registerFileSource(notebookId, filename);
    const uploadUrl = await this.startResumableUpload(notebookId, filename, fileSize, sourceId);
    await this.uploadFileStreaming(uploadUrl, resolved);

    const source: SourceType = {
      id: sourceId,
      title: filename,
      url: null,
      typeCode: null,
      createdAt: null,
      status: SourceStatus.READY,
      kind: Source.fromApiResponse([sourceId, filename]).kind,
      sourceType: Source.fromApiResponse([sourceId, filename]).sourceType,
      isReady: true,
      isProcessing: false,
      isError: false,
    };

    if (wait) {
      return this.waitUntilReady(notebookId, source.id, waitTimeout);
    }

    return source;
  }

  public async addDrive(
    notebookId: string,
    fileId: string,
    title: string,
    mimeType = 'application/vnd.google-apps.document',
    wait = false,
    waitTimeout = 120,
  ): Promise<SourceType> {
    console.debug(`Adding Drive source to notebook ${notebookId}: ${title}`);

    const sourceData = [
      [fileId, mimeType, 1, title],
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      1,
    ];

    const params = [
      [sourceData],
      notebookId,
      [2],
      [1, null, null, null, null, null, null, null, null, null, [1]],
    ];

    const result = await this.core.rpcCall(
      RPCMethod.ADD_SOURCE,
      params,
      `/notebook/${notebookId}`,
      true,
    );
    const source = Source.fromApiResponse(Array.isArray(result) ? result : []);

    if (wait) {
      return this.waitUntilReady(notebookId, source.id, waitTimeout);
    }

    return source;
  }

  public async delete(notebookId: string, sourceId: string): Promise<boolean> {
    console.debug(`Deleting source ${sourceId} from notebook ${notebookId}`);
    const params = [[[sourceId]]];
    await this.core.rpcCall(RPCMethod.DELETE_SOURCE, params, `/notebook/${notebookId}`, true);
    return true;
  }

  public async rename(notebookId: string, sourceId: string, newTitle: string): Promise<SourceType> {
    console.debug(`Renaming source ${sourceId} to: ${newTitle}`);
    const params = [null, [sourceId], [[[newTitle]]]];
    const result = await this.core.rpcCall(
      RPCMethod.UPDATE_SOURCE,
      params,
      `/notebook/${notebookId}`,
      true,
    );

    if (Array.isArray(result)) {
      return Source.fromApiResponse(result);
    }

    return Source.fromApiResponse([sourceId, newTitle]);
  }

  public async refresh(notebookId: string, sourceId: string): Promise<boolean> {
    const params = [null, [sourceId], [2]];
    await this.core.rpcCall(RPCMethod.REFRESH_SOURCE, params, `/notebook/${notebookId}`, true);
    return true;
  }

  public async checkFreshness(notebookId: string, sourceId: string): Promise<boolean> {
    const params = [null, [sourceId], [2]];
    const result = await this.core.rpcCall(
      RPCMethod.CHECK_SOURCE_FRESHNESS,
      params,
      `/notebook/${notebookId}`,
      true,
    );

    if (result === true) {
      return true;
    }

    if (result === false) {
      return false;
    }

    if (Array.isArray(result)) {
      if (result.length === 0) {
        return true;
      }

      const first = result[0];
      if (Array.isArray(first) && first.length > 1 && first[1] === true) {
        return true;
      }
    }

    return false;
  }

  public async getGuide(notebookId: string, sourceId: string): Promise<Record<string, unknown>> {
    const params = [[[[sourceId]]]];
    const result = await this.core.rpcCall(
      RPCMethod.GET_SOURCE_GUIDE,
      params,
      `/notebook/${notebookId}`,
      true,
    );

    let summary = '';
    let keywords: string[] = [];

    if (Array.isArray(result) && result.length > 0) {
      const outer = result[0];
      if (Array.isArray(outer) && outer.length > 0) {
        const inner = outer[0];
        if (Array.isArray(inner)) {
          if (Array.isArray(inner[1]) && inner[1].length > 0 && typeof inner[1][0] === 'string') {
            summary = inner[1][0];
          }

          if (Array.isArray(inner[2]) && inner[2].length > 0 && Array.isArray(inner[2][0])) {
            keywords = inner[2][0].filter((item): item is string => typeof item === 'string');
          }
        }
      }
    }

    return { summary, keywords };
  }

  public async getFulltext(notebookId: string, sourceId: string): Promise<SourceFulltext> {
    const params = [[sourceId], [2], [2]];
    const result = await this.core.rpcCall(
      RPCMethod.GET_SOURCE,
      params,
      `/notebook/${notebookId}`,
      true,
    );

    if (!Array.isArray(result)) {
      throw new SourceNotFoundError(`Source ${sourceId} not found in notebook ${notebookId}`);
    }

    let title = '';
    let sourceType: number | null = null;
    let url: string | null = null;
    let content = '';

    if (Array.isArray(result[0])) {
      const sourceData = result[0];
      if (typeof sourceData[1] === 'string') {
        title = sourceData[1];
      }

      if (Array.isArray(sourceData[2])) {
        if (typeof sourceData[2][4] === 'number') {
          sourceType = sourceData[2][4];
        }

        if (
          Array.isArray(sourceData[2][7]) &&
          sourceData[2][7].length > 0 &&
          typeof sourceData[2][7][0] === 'string'
        ) {
          url = sourceData[2][7][0];
        }
      }
    }

    if (Array.isArray(result[3]) && result[3].length > 0 && Array.isArray(result[3][0])) {
      const texts = this.extractAllText(result[3][0]);
      content = texts.join('\n');
    }

    if (!content) {
      console.warn(
        `Source ${sourceId} returned empty content (type=${String(sourceType)}, title=${title})`,
      );
    }

    return createSourceFulltext({
      sourceId,
      title,
      content,
      typeCode: sourceType,
      url,
    });
  }

  private extractAllText(data: unknown[], maxDepth = 100): string[] {
    if (maxDepth <= 0) {
      console.warn('Max recursion depth reached in text extraction');
      return [];
    }

    const texts: string[] = [];
    for (const item of data) {
      if (typeof item === 'string' && item.length > 0) {
        texts.push(item);
      } else if (Array.isArray(item)) {
        texts.push(...this.extractAllText(item, maxDepth - 1));
      }
    }

    return texts;
  }

  private extractYouTubeVideoId(url: string): string | null {
    try {
      const parsed = new URL(url.trim());
      const hostname = parsed.hostname.toLowerCase();
      const youtubeDomains = new Set([
        'youtube.com',
        'www.youtube.com',
        'm.youtube.com',
        'music.youtube.com',
        'youtu.be',
      ]);

      if (!youtubeDomains.has(hostname)) {
        return null;
      }

      const videoId = this.extractVideoIdFromParsedUrl(parsed, hostname);
      if (videoId && this.isValidVideoId(videoId)) {
        return videoId;
      }

      return null;
    } catch (error) {
      console.debug(`Failed to parse YouTube URL '${url.slice(0, 100)}': ${String(error)}`);
      return null;
    }
  }

  private extractVideoIdFromParsedUrl(parsed: URL, hostname: string): string | null {
    if (hostname === 'youtu.be') {
      const value = parsed.pathname.replace(/^\/+/, '').split('/')[0]?.trim();
      return value || null;
    }

    const pathSegments = parsed.pathname.replace(/^\/+/, '').split('/');
    if (
      pathSegments.length >= 2 &&
      ['shorts', 'embed', 'live', 'v'].includes(pathSegments[0]?.toLowerCase() ?? '')
    ) {
      const value = pathSegments[1]?.trim();
      return value || null;
    }

    const vParam = parsed.searchParams.get('v');
    return vParam?.trim() || null;
  }

  private isValidVideoId(videoId: string): boolean {
    return Boolean(videoId && /^[a-zA-Z0-9_-]+$/.test(videoId));
  }

  private async addYouTubeSource(notebookId: string, url: string): Promise<unknown> {
    const params = [
      [[null, null, null, null, null, null, null, [url], null, null, 1]],
      notebookId,
      [2],
      [1, null, null, null, null, null, null, null, null, null, [1]],
    ];

    return this.core.rpcCall(RPCMethod.ADD_SOURCE, params, `/notebook/${notebookId}`, true);
  }

  private async addUrlSource(notebookId: string, url: string): Promise<unknown> {
    const params = [
      [[null, null, [url], null, null, null, null, null]],
      notebookId,
      [2],
      null,
      null,
    ];
    return this.core.rpcCall(RPCMethod.ADD_SOURCE, params, `/notebook/${notebookId}`);
  }

  private async registerFileSource(notebookId: string, filename: string): Promise<string> {
    const params = [
      [[filename]],
      notebookId,
      [2],
      [1, null, null, null, null, null, null, null, null, null, [1]],
    ];

    const result = await this.core.rpcCall(
      RPCMethod.ADD_SOURCE_FILE,
      params,
      `/notebook/${notebookId}`,
      true,
    );

    const extractId = (data: unknown): string | null => {
      if (typeof data === 'string') {
        return data;
      }

      if (Array.isArray(data) && data.length > 0) {
        return extractId(data[0]);
      }

      return null;
    };

    const sourceId = extractId(result);
    if (sourceId) {
      return sourceId;
    }

    throw new SourceAddError(filename, {
      message: 'Failed to get SOURCE_ID from registration response',
    });
  }

  private async startResumableUpload(
    notebookId: string,
    filename: string,
    fileSize: number,
    sourceId: string,
  ): Promise<string> {
    const url = `${UPLOAD_URL}?authuser=0`;

    const response = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          Accept: '*/*',
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          Cookie: this.core.auth.cookieHeader,
          Origin: 'https://notebooklm.google.com',
          Referer: 'https://notebooklm.google.com/',
          'x-goog-authuser': '0',
          'x-goog-upload-command': 'start',
          'x-goog-upload-header-content-length': String(fileSize),
          'x-goog-upload-protocol': 'resumable',
        },
        body: JSON.stringify({
          PROJECT_ID: notebookId,
          SOURCE_NAME: filename,
          SOURCE_ID: sourceId,
        }),
      },
      60_000,
    );

    if (!response.ok) {
      throw new SourceAddError(filename, {
        message: `Failed to start resumable upload: HTTP ${response.status} ${response.statusText}`,
      });
    }

    const uploadUrl = response.headers.get('x-goog-upload-url');
    if (!uploadUrl) {
      throw new SourceAddError(filename, {
        message: 'Failed to get upload URL from response headers',
      });
    }

    return uploadUrl;
  }

  private async uploadFileStreaming(uploadUrl: string, filePath: string): Promise<void> {
    const { Readable } = await import('node:stream');
    const nodeStream = createReadStream(filePath, { highWaterMark: 65_536 });
    // Convert Node ReadStream to web ReadableStream for native fetch compatibility
    const webStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;

    const response = await fetchWithTimeout(
      uploadUrl,
      {
        method: 'POST',
        headers: {
          Accept: '*/*',
          'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
          Cookie: this.core.auth.cookieHeader,
          Origin: 'https://notebooklm.google.com',
          Referer: 'https://notebooklm.google.com/',
          'x-goog-authuser': '0',
          'x-goog-upload-command': 'upload, finalize',
          'x-goog-upload-offset': '0',
        },
        body: webStream,
        // Required by Node fetch for streamed request bodies.
        duplex: 'half' as never,
      } as RequestInit,
      300_000,
    );

    if (!response.ok) {
      throw new SourceAddError(filePath, {
        message: `File upload failed: HTTP ${response.status} ${response.statusText}`,
      });
    }
  }
}
