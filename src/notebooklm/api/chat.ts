import { randomUUID } from 'node:crypto';
import type { ClientCore } from '../core.js';
import { ChatError, NetworkError, ValidationError } from '../errors.js';
import { QUERY_URL, RPCMethod } from '../rpc/types.js';
import {
  type AskResult,
  ChatGoal,
  ChatMode,
  type ChatReference,
  ChatResponseLength,
  type ConversationTurn,
} from '../types.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN_ANSWER_LENGTH = 20;

export class ChatAPI {
  private readonly core: ClientCore;

  public constructor(core: ClientCore) {
    this.core = core;
  }

  public async ask(
    notebookId: string,
    question: string,
    sourceIds?: string[] | null,
    conversationId?: string | null,
  ): Promise<AskResult> {
    console.debug(
      `Asking question in notebook ${notebookId} (conversation=${conversationId ?? 'new'})`,
    );

    let ids = sourceIds;
    if (!ids) {
      ids = await this.core.getSourceIds(notebookId);
    }

    const isNewConversation = !conversationId;
    let resolvedConversationId = conversationId;
    let conversationHistory: unknown[] | null = null;

    if (isNewConversation) {
      resolvedConversationId = randomUUID();
    } else {
      conversationHistory = this.buildConversationHistory(resolvedConversationId);
    }

    const sourcesArray = ids.length > 0 ? ids.map((sourceId) => [[sourceId]]) : [];

    const params = [
      sourcesArray,
      question,
      conversationHistory,
      [2, null, [1]],
      resolvedConversationId,
    ];

    const paramsJson = JSON.stringify(params);
    const fReq = [null, paramsJson];
    const fReqJson = JSON.stringify(fReq);

    const bodyParts = [`f.req=${encodeURIComponent(fReqJson)}`];
    if (this.core.auth.csrfToken) {
      bodyParts.push(`at=${encodeURIComponent(this.core.auth.csrfToken)}`);
    }

    const body = `${bodyParts.join('&')}&`;

    const reqId = this.core.nextReqIdStep();
    const urlParams = new URLSearchParams({
      bl: process.env.NOTEBOOKLM_BL ?? 'boq_labs-tailwind-frontend_20260221.14_p0',
      hl: 'en',
      _reqid: String(reqId),
      rt: 'c',
    });

    if (this.core.auth.sessionId) {
      urlParams.set('f.sid', this.core.auth.sessionId);
    }

    const url = `${QUERY_URL}?${urlParams.toString()}`;

    const httpClient = this.core.getHttpClient();
    let response: Response;

    try {
      response = await httpClient.post(url, body, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        },
      });
    } catch (error) {
      throw new NetworkError(`Chat request failed: ${String(error)}`, {
        originalError: error instanceof Error ? error : null,
      });
    }

    if (!response.ok) {
      if (response.status === 408 || response.status === 504) {
        throw new NetworkError(`Chat request timed out: HTTP ${response.status}`);
      }

      throw new ChatError(
        `Chat request failed with HTTP ${response.status}: ${response.statusText}`,
      );
    }

    const responseText = await response.text();
    const [answerText, references] = this.parseAskResponseWithReferences(responseText);

    const turns = this.core.getCachedConversation(resolvedConversationId ?? '');
    let turnNumber = turns.length;

    if (answerText) {
      turnNumber = turns.length + 1;
      this.core.cacheConversationTurn(
        resolvedConversationId ?? '',
        question,
        answerText,
        turnNumber,
      );
    }

    return {
      answer: answerText,
      conversationId: resolvedConversationId ?? '',
      turnNumber,
      isFollowUp: !isNewConversation,
      references,
      rawResponse: responseText.slice(0, 1000),
    };
  }

  public async getHistory(notebookId: string, limit = 20): Promise<unknown> {
    console.debug(`Getting conversation history for notebook ${notebookId} (limit=${limit})`);
    const params: unknown[] = [[], null, notebookId, limit];
    return this.core.rpcCall(RPCMethod.GET_CONVERSATION_HISTORY, params, `/notebook/${notebookId}`);
  }

  public getCachedTurns(conversationId: string): ConversationTurn[] {
    return this.core.getCachedConversation(conversationId).map((turn) => ({
      query: turn.query,
      answer: turn.answer,
      turnNumber: turn.turnNumber,
    }));
  }

  public clearCache(conversationId?: string | null): boolean {
    return this.core.clearConversationCache(conversationId);
  }

  public async configure(
    notebookId: string,
    goal: ChatGoal = ChatGoal.DEFAULT,
    responseLength: ChatResponseLength = ChatResponseLength.DEFAULT,
    customPrompt?: string | null,
  ): Promise<void> {
    console.debug(`Configuring chat for notebook ${notebookId}`);

    if (goal === ChatGoal.CUSTOM && !customPrompt) {
      throw new ValidationError('customPrompt is required when goal is CUSTOM');
    }

    const goalArray = goal === ChatGoal.CUSTOM ? [goal, customPrompt] : [goal];
    const chatSettings = [goalArray, [responseLength]];

    const params = [notebookId, [[null, null, null, null, null, null, null, chatSettings]]];

    await this.core.rpcCall(RPCMethod.RENAME_NOTEBOOK, params, `/notebook/${notebookId}`, true);
  }

  public async setMode(notebookId: string, mode: ChatMode): Promise<void> {
    const modeConfigs: Record<ChatMode, [ChatGoal, ChatResponseLength, string | null]> = {
      [ChatMode.DEFAULT]: [ChatGoal.DEFAULT, ChatResponseLength.DEFAULT, null],
      [ChatMode.LEARNING_GUIDE]: [ChatGoal.LEARNING_GUIDE, ChatResponseLength.LONGER, null],
      [ChatMode.CONCISE]: [ChatGoal.DEFAULT, ChatResponseLength.SHORTER, null],
      [ChatMode.DETAILED]: [ChatGoal.DEFAULT, ChatResponseLength.LONGER, null],
    };

    const [goal, length, prompt] = modeConfigs[mode];
    await this.configure(notebookId, goal, length, prompt);
  }

  private buildConversationHistory(conversationId: string | null | undefined): unknown[] | null {
    if (!conversationId) {
      return null;
    }

    const turns = this.core.getCachedConversation(conversationId);
    if (turns.length === 0) {
      return null;
    }

    const history: unknown[] = [];
    for (const turn of turns) {
      history.push([turn.answer, null, 2]);
      history.push([turn.query, null, 1]);
    }

    return history;
  }

  private parseAskResponseWithReferences(responseText: string): [string, ChatReference[]] {
    let text = responseText;
    if (text.startsWith(")]}'")) {
      text = text.slice(4);
    }

    const lines = text.trim().split('\n');
    let longestAnswer = '';
    let longestText = ''; // Fallback: longest text even if isAnswer is false
    const allReferences: ChatReference[] = [];

    const processChunk = (jsonStr: string): void => {
      const [chunkText, isAnswer, refs] = this.extractAnswerAndRefsFromChunk(jsonStr);
      if (chunkText) {
        // Track the longest text regardless of isAnswer for fallback
        if (chunkText.length > longestText.length) {
          longestText = chunkText;
        }
        if (isAnswer && chunkText.length > longestAnswer.length) {
          longestAnswer = chunkText;
        }
      }
      allReferences.push(...refs);
    };

    let index = 0;
    while (index < lines.length) {
      const line = lines[index]?.trim() ?? '';
      if (!line) {
        index += 1;
        continue;
      }

      if (/^\d+$/.test(line)) {
        index += 1;
        if (index < lines.length) {
          processChunk(lines[index] ?? '');
        }
        index += 1;
        continue;
      }

      processChunk(line);
      index += 1;
    }

    if (!longestAnswer) {
      if (longestText) {
        // Fallback: API structure may have changed or notebook is empty —
        // accept the longest text chunk even without the strict isAnswer flag
        console.debug(
          `No strict answer found — using longest text chunk as fallback (${longestText.length} chars)`,
        );
        longestAnswer = longestText;
      } else {
        console.debug(`No answer extracted from response (${lines.length} lines parsed)`);
      }
    }

    for (let i = 0; i < allReferences.length; i += 1) {
      if (allReferences[i] && allReferences[i].citationNumber === null) {
        allReferences[i].citationNumber = i + 1;
      }
    }

    return [longestAnswer, allReferences];
  }

  private extractAnswerAndRefsFromChunk(
    jsonStr: string,
  ): [string | null, boolean, ChatReference[]] {
    const refs: ChatReference[] = [];

    let data: unknown;
    try {
      data = JSON.parse(jsonStr);
    } catch {
      return [null, false, refs];
    }

    if (!Array.isArray(data)) {
      return [null, false, refs];
    }

    for (const item of data) {
      if (!Array.isArray(item) || item.length < 3) {
        continue;
      }

      if (item[0] !== 'wrb.fr') {
        continue;
      }

      const innerJson = item[2];
      if (typeof innerJson !== 'string') {
        continue;
      }

      try {
        const innerData = JSON.parse(innerJson);
        if (!Array.isArray(innerData) || innerData.length === 0) {
          continue;
        }

        const first = innerData[0];
        if (!Array.isArray(first) || first.length === 0) {
          continue;
        }

        const chunkText = first[0];
        let isAnswer = false;
        if (typeof chunkText === 'string' && chunkText.length > MIN_ANSWER_LENGTH) {
          if (Array.isArray(first[4])) {
            const typeInfo = first[4];
            if (typeInfo.length > 0 && typeInfo[typeInfo.length - 1] === 1) {
              isAnswer = true;
            }
          } else {
            // No type_info at all — treat as answer (empty notebook or API change)
            isAnswer = true;
          }

          const citations = this.parseCitations(first);
          return [chunkText, isAnswer, citations];
        }
      } catch {}
    }

    return [null, false, refs];
  }

  private parseCitations(first: unknown[]): ChatReference[] {
    try {
      if (!Array.isArray(first[4])) {
        return [];
      }

      const typeInfo = first[4] as unknown[];
      if (!Array.isArray(typeInfo[3])) {
        return [];
      }

      const refs: ChatReference[] = [];
      for (const citation of typeInfo[3]) {
        const ref = this.parseSingleCitation(citation);
        if (ref) {
          refs.push(ref);
        }
      }

      return refs;
    } catch (error) {
      console.debug(`Citation parsing failed (API structure may have changed): ${String(error)}`);
      return [];
    }
  }

  private parseSingleCitation(cite: unknown): ChatReference | null {
    if (!Array.isArray(cite) || cite.length < 2 || !Array.isArray(cite[1])) {
      return null;
    }

    const citeInner = cite[1] as unknown[];
    const sourceIdData = citeInner.length > 5 ? citeInner[5] : null;
    const sourceId = this.extractUuidFromNested(sourceIdData);
    if (!sourceId) {
      return null;
    }

    let chunkId: string | null = null;
    if (Array.isArray(cite[0]) && cite[0].length > 0 && typeof cite[0][0] === 'string') {
      chunkId = cite[0][0];
    }

    const [citedText, startChar, endChar] = this.extractTextPassages(citeInner);

    return {
      sourceId,
      citationNumber: null,
      citedText,
      startChar,
      endChar,
      chunkId,
    };
  }

  private extractTextPassages(citeInner: unknown[]): [string | null, number | null, number | null] {
    if (!Array.isArray(citeInner[4])) {
      return [null, null, null];
    }

    const texts: string[] = [];
    let startChar: number | null = null;
    let endChar: number | null = null;

    for (const passageWrapper of citeInner[4] as unknown[]) {
      if (
        !Array.isArray(passageWrapper) ||
        passageWrapper.length === 0 ||
        !Array.isArray(passageWrapper[0])
      ) {
        continue;
      }

      const passageData = passageWrapper[0] as unknown[];
      if (passageData.length < 3) {
        continue;
      }

      if (startChar === null && typeof passageData[0] === 'number') {
        startChar = passageData[0];
      }

      if (typeof passageData[1] === 'number') {
        endChar = passageData[1];
      }

      this.collectTextsFromNested(passageData[2], texts);
    }

    const citedText = texts.length > 0 ? texts.join(' ') : null;
    return [citedText, startChar, endChar];
  }

  private collectTextsFromNested(nested: unknown, texts: string[]): void {
    if (!Array.isArray(nested)) {
      return;
    }

    for (const nestedGroup of nested) {
      if (!Array.isArray(nestedGroup)) {
        continue;
      }

      for (const inner of nestedGroup) {
        if (!Array.isArray(inner) || inner.length < 3) {
          continue;
        }

        const textVal = inner[2];
        if (typeof textVal === 'string' && textVal.trim().length > 0) {
          texts.push(textVal.trim());
        } else if (Array.isArray(textVal)) {
          for (const item of textVal) {
            if (typeof item === 'string' && item.trim().length > 0) {
              texts.push(item.trim());
            }
          }
        }
      }
    }
  }

  private extractUuidFromNested(data: unknown, maxDepth = 10): string | null {
    if (maxDepth <= 0) {
      console.warn('Max recursion depth reached in UUID extraction');
      return null;
    }

    if (typeof data === 'string') {
      return UUID_PATTERN.test(data) ? data : null;
    }

    if (Array.isArray(data)) {
      for (const item of data) {
        const result = this.extractUuidFromNested(item, maxDepth - 1);
        if (result) {
          return result;
        }
      }
    }

    return null;
  }
}
