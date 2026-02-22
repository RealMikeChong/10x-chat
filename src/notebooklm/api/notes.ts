import type { ClientCore } from '../core.js';
import { RPCMethod } from '../rpc/types.js';
import type { Note as NoteType } from '../types.js';

export class NotesAPI {
  private readonly core: ClientCore;

  public constructor(core: ClientCore) {
    this.core = core;
  }

  public async list(notebookId: string): Promise<NoteType[]> {
    console.debug(`Listing notes in notebook: ${notebookId}`);
    const allItems = await this.getAllNotesAndMindMaps(notebookId);
    const notes: NoteType[] = [];

    for (const item of allItems) {
      if (this.isDeleted(item)) {
        continue;
      }

      const content = this.extractContent(item);
      const isMindMap = Boolean(
        content && (content.includes('"children":') || content.includes('"nodes":')),
      );
      if (!isMindMap) {
        notes.push(this.parseNote(item, notebookId));
      }
    }

    return notes;
  }

  public async get(notebookId: string, noteId: string): Promise<NoteType | null> {
    const allItems = await this.getAllNotesAndMindMaps(notebookId);
    for (const item of allItems) {
      if (Array.isArray(item) && item.length > 0 && item[0] === noteId) {
        return this.parseNote(item, notebookId);
      }
    }

    return null;
  }

  public async create(notebookId: string, title = 'New Note', content = ''): Promise<NoteType> {
    console.debug(`Creating note in notebook ${notebookId}: ${title}`);
    const params = [notebookId, '', [1], null, 'New Note'];
    const result = await this.core.rpcCall(
      RPCMethod.CREATE_NOTE,
      params,
      `/notebook/${notebookId}`,
    );

    let noteId: string | null = null;
    if (Array.isArray(result) && result.length > 0) {
      if (Array.isArray(result[0]) && result[0].length > 0 && typeof result[0][0] === 'string') {
        noteId = result[0][0];
      } else if (typeof result[0] === 'string') {
        noteId = result[0];
      }
    }

    if (noteId) {
      await this.update(notebookId, noteId, content, title);
    }

    return {
      id: noteId ?? '',
      notebookId,
      title,
      content,
      createdAt: null,
    };
  }

  public async update(
    notebookId: string,
    noteId: string,
    content: string,
    title: string,
  ): Promise<void> {
    console.debug(`Updating note ${noteId} in notebook ${notebookId}`);
    const params = [notebookId, noteId, [[[content, title, [], 0]]]];
    await this.core.rpcCall(RPCMethod.UPDATE_NOTE, params, `/notebook/${notebookId}`, true);
  }

  public async delete(notebookId: string, noteId: string): Promise<boolean> {
    console.debug(`Deleting note ${noteId} from notebook ${notebookId}`);
    const params = [notebookId, null, [noteId]];
    await this.core.rpcCall(RPCMethod.DELETE_NOTE, params, `/notebook/${notebookId}`, true);
    return true;
  }

  public async listMindMaps(notebookId: string): Promise<unknown[][]> {
    const allItems = await this.getAllNotesAndMindMaps(notebookId);
    const mindMaps: unknown[][] = [];

    for (const item of allItems) {
      if (this.isDeleted(item)) {
        continue;
      }

      const content = this.extractContent(item);
      if (content && (content.includes('"children":') || content.includes('"nodes":'))) {
        mindMaps.push(item);
      }
    }

    return mindMaps;
  }

  public async deleteMindMap(notebookId: string, mindMapId: string): Promise<boolean> {
    const params = [notebookId, null, [mindMapId]];
    await this.core.rpcCall(RPCMethod.DELETE_NOTE, params, `/notebook/${notebookId}`, true);
    return true;
  }

  private async getAllNotesAndMindMaps(notebookId: string): Promise<unknown[][]> {
    const params = [notebookId];
    const result = await this.core.rpcCall(
      RPCMethod.GET_NOTES_AND_MIND_MAPS,
      params,
      `/notebook/${notebookId}`,
      true,
    );

    if (Array.isArray(result) && result.length > 0 && Array.isArray(result[0])) {
      const notesList = result[0];
      return notesList.filter(
        (item): item is unknown[] =>
          Array.isArray(item) && item.length > 0 && typeof item[0] === 'string',
      );
    }

    return [];
  }

  private isDeleted(item: unknown[]): boolean {
    if (!Array.isArray(item) || item.length < 3) {
      return false;
    }

    return item[1] === null && item[2] === 2;
  }

  private extractContent(item: unknown[]): string | null {
    if (item.length <= 1) {
      return null;
    }

    if (typeof item[1] === 'string') {
      return item[1];
    }

    if (Array.isArray(item[1]) && item[1].length > 1 && typeof item[1][1] === 'string') {
      return item[1][1];
    }

    return null;
  }

  private parseNote(item: unknown[], notebookId: string): NoteType {
    const noteId = typeof item[0] === 'string' ? item[0] : String(item[0] ?? '');

    let content = '';
    let title = '';

    if (item.length > 1) {
      if (typeof item[1] === 'string') {
        content = item[1];
      } else if (Array.isArray(item[1])) {
        const inner = item[1];
        if (inner.length > 1 && typeof inner[1] === 'string') {
          content = inner[1];
        }
        if (inner.length > 4 && typeof inner[4] === 'string') {
          title = inner[4];
        }
      }
    }

    return {
      id: noteId,
      notebookId,
      title,
      content,
      createdAt: null,
    };
  }
}
