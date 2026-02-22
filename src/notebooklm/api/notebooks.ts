import type { ClientCore } from '../core.js';
import { RPCMethod } from '../rpc/types.js';
import { Notebook, type NotebookDescription, type SuggestedTopic } from '../types.js';

export class NotebooksAPI {
  private readonly core: ClientCore;

  public constructor(core: ClientCore) {
    this.core = core;
  }

  public async list(): Promise<ReturnType<typeof Notebook.fromApiResponse>[]> {
    console.debug('Listing notebooks');
    const params = [null, 1, null, [2]];
    const result = await this.core.rpcCall(RPCMethod.LIST_NOTEBOOKS, params);

    if (Array.isArray(result) && result.length > 0) {
      const rawNotebooks = Array.isArray(result[0]) ? result[0] : result;
      return rawNotebooks
        .filter((value): value is unknown[] => Array.isArray(value))
        .map((nb) => Notebook.fromApiResponse(nb));
    }

    return [];
  }

  public async create(title: string): Promise<ReturnType<typeof Notebook.fromApiResponse>> {
    console.debug(`Creating notebook: ${title}`);
    const params = [title, null, null, [2], [1]];
    const result = await this.core.rpcCall(RPCMethod.CREATE_NOTEBOOK, params);
    const notebook = Notebook.fromApiResponse(Array.isArray(result) ? result : []);
    console.debug(`Created notebook: ${notebook.id}`);
    return notebook;
  }

  public async get(notebookId: string): Promise<ReturnType<typeof Notebook.fromApiResponse>> {
    const params = [notebookId, null, [2], null, 0];
    const result = await this.core.rpcCall(
      RPCMethod.GET_NOTEBOOK,
      params,
      `/notebook/${notebookId}`,
    );

    const notebookInfo =
      Array.isArray(result) && result.length > 0 && Array.isArray(result[0]) ? result[0] : [];
    return Notebook.fromApiResponse(notebookInfo);
  }

  public async delete(notebookId: string): Promise<boolean> {
    console.debug(`Deleting notebook: ${notebookId}`);
    const params = [[notebookId], [2]];
    await this.core.rpcCall(RPCMethod.DELETE_NOTEBOOK, params);
    return true;
  }

  public async rename(
    notebookId: string,
    newTitle: string,
  ): Promise<ReturnType<typeof Notebook.fromApiResponse>> {
    console.debug(`Renaming notebook ${notebookId} to: ${newTitle}`);
    const params = [notebookId, [[null, null, null, [null, newTitle]]]];

    await this.core.rpcCall(RPCMethod.RENAME_NOTEBOOK, params, '/', true);
    return this.get(notebookId);
  }

  public async getSummary(notebookId: string): Promise<string> {
    const params = [notebookId, [2]];
    const result = await this.core.rpcCall(RPCMethod.SUMMARIZE, params, `/notebook/${notebookId}`);

    if (Array.isArray(result) && result.length > 0) {
      return typeof result[0] === 'string' ? result[0] : '';
    }

    return '';
  }

  public async getDescription(notebookId: string): Promise<NotebookDescription> {
    const params = [notebookId, [2]];
    const result = await this.core.rpcCall(RPCMethod.SUMMARIZE, params, `/notebook/${notebookId}`);

    let summary = '';
    const suggestedTopics: SuggestedTopic[] = [];

    if (Array.isArray(result)) {
      if (Array.isArray(result[0]) && result[0].length > 0 && typeof result[0][0] === 'string') {
        summary = result[0][0];
      }

      if (Array.isArray(result[1]) && result[1].length > 0) {
        const topicsList = Array.isArray(result[1][0]) ? result[1][0] : [];
        for (const topic of topicsList) {
          if (!Array.isArray(topic) || topic.length < 2) {
            continue;
          }

          suggestedTopics.push({
            question: typeof topic[0] === 'string' ? topic[0] : '',
            prompt: typeof topic[1] === 'string' ? topic[1] : '',
          });
        }
      }
    }

    return {
      summary,
      suggestedTopics,
    };
  }

  public async removeFromRecent(notebookId: string): Promise<void> {
    const params = [notebookId];
    await this.core.rpcCall(RPCMethod.REMOVE_RECENTLY_VIEWED, params, '/', true);
  }

  public async getRaw(notebookId: string): Promise<unknown> {
    const params = [notebookId, null, [2], null, 0];
    return this.core.rpcCall(RPCMethod.GET_NOTEBOOK, params, `/notebook/${notebookId}`);
  }

  public async share(
    notebookId: string,
    publicShare = true,
    artifactId?: string | null,
  ): Promise<{ public: boolean; url: string | null; artifactId: string | null }> {
    const shareOptions = publicShare ? [1] : [0];
    const params = artifactId ? [shareOptions, notebookId, artifactId] : [shareOptions, notebookId];

    await this.core.rpcCall(RPCMethod.SHARE_ARTIFACT, params, `/notebook/${notebookId}`, true);

    const baseUrl = `https://notebooklm.google.com/notebook/${notebookId}`;
    const url = publicShare ? (artifactId ? `${baseUrl}?artifactId=${artifactId}` : baseUrl) : null;

    return {
      public: publicShare,
      url,
      artifactId: artifactId ?? null,
    };
  }

  public getShareUrl(notebookId: string, artifactId?: string | null): string {
    const baseUrl = `https://notebooklm.google.com/notebook/${notebookId}`;
    if (artifactId) {
      return `${baseUrl}?artifactId=${artifactId}`;
    }
    return baseUrl;
  }
}
