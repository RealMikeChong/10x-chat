import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ClientCore } from '../core.js';
import {
  ArtifactDownloadError,
  ArtifactNotFoundError,
  ArtifactNotReadyError,
  ArtifactParseError,
  RPCError,
  ValidationError,
} from '../errors.js';
import {
  ArtifactStatus,
  ArtifactTypeCode,
  type AudioFormat,
  type AudioLength,
  artifactStatusToStr,
  ExportType,
  type InfographicDetail,
  type InfographicOrientation,
  type QuizDifficulty,
  type QuizQuantity,
  ReportFormat,
  RPCMethod,
  type SlideDeckFormat,
  type SlideDeckLength,
  type VideoFormat,
  type VideoStyle,
} from '../rpc/types.js';
import {
  Artifact,
  ArtifactType,
  createGenerationStatus,
  type GenerationStatus,
  type ReportSuggestion,
} from '../types.js';
import type { NotesAPI } from './notes.js';

const MEDIA_ARTIFACT_TYPES = new Set<number>([
  ArtifactTypeCode.AUDIO,
  ArtifactTypeCode.VIDEO,
  ArtifactTypeCode.INFOGRAPHIC,
  ArtifactTypeCode.SLIDE_DECK,
]);

function extractAppData(htmlContent: string): Record<string, unknown> {
  const match = /data-app-data="([^"]+)"/.exec(htmlContent);
  if (!match) {
    throw new ArtifactParseError('quiz/flashcard', {
      details: 'No data-app-data attribute found in HTML',
    });
  }

  const encodedJson = match[1] ?? '';
  const decodedJson = encodedJson
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');

  return JSON.parse(decodedJson) as Record<string, unknown>;
}

function formatQuizMarkdown(title: string, questions: Array<Record<string, unknown>>): string {
  const lines: string[] = [`# ${title}`, ''];

  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index] ?? {};
    lines.push(`## Question ${index + 1}`);
    lines.push(typeof question.question === 'string' ? question.question : '');
    lines.push('');

    const options = Array.isArray(question.answerOptions) ? question.answerOptions : [];
    for (const option of options) {
      if (!option || typeof option !== 'object') {
        continue;
      }

      const marker = (option as { isCorrect?: unknown }).isCorrect ? '[x]' : '[ ]';
      const text =
        typeof (option as { text?: unknown }).text === 'string'
          ? (option as { text: string }).text
          : '';
      lines.push(`- ${marker} ${text}`);
    }

    if (typeof question.hint === 'string' && question.hint.length > 0) {
      lines.push('');
      lines.push(`**Hint:** ${question.hint}`);
    }

    lines.push('');
  }

  return lines.join('\n');
}

function formatFlashcardsMarkdown(title: string, cards: Array<Record<string, unknown>>): string {
  const lines: string[] = [`# ${title}`, ''];

  for (let index = 0; index < cards.length; index += 1) {
    const card = cards[index] ?? {};
    const front = typeof card.f === 'string' ? card.f : '';
    const back = typeof card.b === 'string' ? card.b : '';

    lines.push(`## Card ${index + 1}`);
    lines.push('');
    lines.push(`**Q:** ${front}`);
    lines.push('');
    lines.push(`**A:** ${back}`);
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

function extractCellText(cell: unknown): string {
  if (typeof cell === 'string') {
    return cell;
  }

  if (typeof cell === 'number') {
    return '';
  }

  if (Array.isArray(cell)) {
    return cell.map((item) => extractCellText(item)).join('');
  }

  return '';
}

function parseDataTable(rawData: unknown[]): [string[], string[][]] {
  try {
    const rowsArray = (
      (
        (((rawData[0] as unknown[])[0] as unknown[])[0] as unknown[])[0] as unknown[]
      )[4] as unknown[]
    )[2] as unknown[];
    if (!Array.isArray(rowsArray) || rowsArray.length === 0) {
      throw new ArtifactParseError('data_table', { details: 'Empty data table' });
    }

    const headers: string[] = [];
    const rows: string[][] = [];

    for (let i = 0; i < rowsArray.length; i += 1) {
      const rowSection = rowsArray[i];
      if (!Array.isArray(rowSection) || rowSection.length < 3 || !Array.isArray(rowSection[2])) {
        continue;
      }

      const rowValues = (rowSection[2] as unknown[]).map((cell) => extractCellText(cell));
      if (i === 0) {
        headers.push(...rowValues);
      } else {
        rows.push(rowValues);
      }
    }

    if (headers.length === 0) {
      throw new ArtifactParseError('data_table', {
        details: 'Failed to extract headers from data table',
      });
    }

    return [headers, rows];
  } catch (error) {
    if (error instanceof ArtifactParseError) {
      throw error;
    }

    throw new ArtifactParseError('data_table', {
      details: `Failed to parse data table structure: ${String(error)}`,
      cause: error instanceof Error ? error : null,
    });
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

export class ArtifactsAPI {
  private readonly core: ClientCore;
  private readonly notes: NotesAPI;

  public constructor(core: ClientCore, notesApi: NotesAPI) {
    this.core = core;
    this.notes = notesApi;
  }

  public async list(
    notebookId: string,
    artifactType?: ArtifactType | null,
  ): Promise<ReturnType<typeof Artifact.fromApiResponse>[]> {
    console.debug(`Listing artifacts in notebook ${notebookId}`);

    const artifacts: ReturnType<typeof Artifact.fromApiResponse>[] = [];

    const params = [[2], notebookId, 'NOT artifact.status = "ARTIFACT_STATUS_SUGGESTED"'];
    const result = await this.core.rpcCall(
      RPCMethod.LIST_ARTIFACTS,
      params,
      `/notebook/${notebookId}`,
      true,
    );

    let artifactsData: unknown[] = [];
    if (Array.isArray(result) && result.length > 0) {
      artifactsData = Array.isArray(result[0]) ? (result[0] as unknown[]) : result;
    }

    for (const artifactData of artifactsData) {
      if (!Array.isArray(artifactData) || artifactData.length === 0) {
        continue;
      }

      const artifact = Artifact.fromApiResponse(artifactData);
      if (!artifactType || artifact.kind === artifactType) {
        artifacts.push(artifact);
      }
    }

    if (!artifactType || artifactType === ArtifactType.MIND_MAP) {
      try {
        const mindMaps = await this.notes.listMindMaps(notebookId);
        for (const mindMapData of mindMaps) {
          if (!Array.isArray(mindMapData)) {
            continue;
          }

          const mindMapArtifact = Artifact.fromMindMap(mindMapData);
          if (mindMapArtifact && (!artifactType || mindMapArtifact.kind === artifactType)) {
            artifacts.push(mindMapArtifact);
          }
        }
      } catch (error) {
        console.warn(`Failed to fetch mind maps: ${String(error)}`);
      }
    }

    return artifacts;
  }

  public async get(
    notebookId: string,
    artifactId: string,
  ): Promise<ReturnType<typeof Artifact.fromApiResponse> | null> {
    console.debug(`Getting artifact ${artifactId} from notebook ${notebookId}`);

    const artifacts = await this.list(notebookId);
    return artifacts.find((artifact) => artifact.id === artifactId) ?? null;
  }

  public async listAudio(
    notebookId: string,
  ): Promise<ReturnType<typeof Artifact.fromApiResponse>[]> {
    return this.list(notebookId, ArtifactType.AUDIO);
  }

  public async listVideo(
    notebookId: string,
  ): Promise<ReturnType<typeof Artifact.fromApiResponse>[]> {
    return this.list(notebookId, ArtifactType.VIDEO);
  }

  public async listReports(
    notebookId: string,
  ): Promise<ReturnType<typeof Artifact.fromApiResponse>[]> {
    return this.list(notebookId, ArtifactType.REPORT);
  }

  public async listQuizzes(
    notebookId: string,
  ): Promise<ReturnType<typeof Artifact.fromApiResponse>[]> {
    return this.list(notebookId, ArtifactType.QUIZ);
  }

  public async listFlashcards(
    notebookId: string,
  ): Promise<ReturnType<typeof Artifact.fromApiResponse>[]> {
    return this.list(notebookId, ArtifactType.FLASHCARDS);
  }

  public async listInfographics(
    notebookId: string,
  ): Promise<ReturnType<typeof Artifact.fromApiResponse>[]> {
    return this.list(notebookId, ArtifactType.INFOGRAPHIC);
  }

  public async listSlideDecks(
    notebookId: string,
  ): Promise<ReturnType<typeof Artifact.fromApiResponse>[]> {
    return this.list(notebookId, ArtifactType.SLIDE_DECK);
  }

  public async listDataTables(
    notebookId: string,
  ): Promise<ReturnType<typeof Artifact.fromApiResponse>[]> {
    return this.list(notebookId, ArtifactType.DATA_TABLE);
  }

  public async generateAudio(
    notebookId: string,
    sourceIds?: string[] | null,
    language = 'en',
    instructions?: string | null,
    audioFormat?: AudioFormat | null,
    audioLength?: AudioLength | null,
  ): Promise<GenerationStatus> {
    let ids = sourceIds;
    if (!ids) {
      ids = await this.core.getSourceIds(notebookId);
    }

    const sourceIdsTriple = ids.length > 0 ? ids.map((sid) => [[sid]]) : [];
    const sourceIdsDouble = ids.length > 0 ? ids.map((sid) => [sid]) : [];

    const formatCode = audioFormat ?? null;
    const lengthCode = audioLength ?? null;

    const params = [
      [2],
      notebookId,
      [
        null,
        null,
        1,
        sourceIdsTriple,
        null,
        null,
        [
          null,
          [instructions ?? null, lengthCode, null, sourceIdsDouble, language, null, formatCode],
        ],
      ],
    ];

    return this.callGenerate(notebookId, params);
  }

  public async generateVideo(
    notebookId: string,
    sourceIds?: string[] | null,
    language = 'en',
    instructions?: string | null,
    videoFormat?: VideoFormat | null,
    videoStyle?: VideoStyle | null,
  ): Promise<GenerationStatus> {
    let ids = sourceIds;
    if (!ids) {
      ids = await this.core.getSourceIds(notebookId);
    }

    const sourceIdsTriple = ids.length > 0 ? ids.map((sid) => [[sid]]) : [];
    const sourceIdsDouble = ids.length > 0 ? ids.map((sid) => [sid]) : [];

    const formatCode = videoFormat ?? null;
    const styleCode = videoStyle ?? null;

    const params = [
      [2],
      notebookId,
      [
        null,
        null,
        3,
        sourceIdsTriple,
        null,
        null,
        null,
        null,
        [
          null,
          null,
          [sourceIdsDouble, language, instructions ?? null, null, formatCode, styleCode],
        ],
      ],
    ];

    return this.callGenerate(notebookId, params);
  }

  public async generateReport(
    notebookId: string,
    reportFormat: ReportFormat = ReportFormat.BRIEFING_DOC,
    sourceIds?: string[] | null,
    language = 'en',
    customPrompt?: string | null,
  ): Promise<GenerationStatus> {
    let ids = sourceIds;
    if (!ids) {
      ids = await this.core.getSourceIds(notebookId);
    }

    const formatConfigs: Record<
      ReportFormat,
      { title: string; description: string; prompt: string }
    > = {
      [ReportFormat.BRIEFING_DOC]: {
        title: 'Briefing Doc',
        description: 'Key insights and important quotes',
        prompt:
          'Create a comprehensive briefing document that includes an Executive Summary, detailed analysis of key themes, important quotes with context, and actionable insights.',
      },
      [ReportFormat.STUDY_GUIDE]: {
        title: 'Study Guide',
        description: 'Short-answer quiz, essay questions, glossary',
        prompt:
          'Create a comprehensive study guide that includes key concepts, short-answer practice questions, essay prompts for deeper exploration, and a glossary of important terms.',
      },
      [ReportFormat.BLOG_POST]: {
        title: 'Blog Post',
        description: 'Insightful takeaways in readable article format',
        prompt:
          'Write an engaging blog post that presents the key insights in an accessible, reader-friendly format. Include an attention-grabbing introduction, well-organized sections, and a compelling conclusion with takeaways.',
      },
      [ReportFormat.CUSTOM]: {
        title: 'Custom Report',
        description: 'Custom format',
        prompt: customPrompt ?? 'Create a report based on the provided sources.',
      },
    };

    const config = formatConfigs[reportFormat];
    const sourceIdsTriple = ids.length > 0 ? ids.map((sid) => [[sid]]) : [];
    const sourceIdsDouble = ids.length > 0 ? ids.map((sid) => [sid]) : [];

    const params = [
      [2],
      notebookId,
      [
        null,
        null,
        2,
        sourceIdsTriple,
        null,
        null,
        null,
        [
          null,
          [
            config.title,
            config.description,
            null,
            sourceIdsDouble,
            language,
            config.prompt,
            null,
            true,
          ],
        ],
      ],
    ];

    return this.callGenerate(notebookId, params);
  }

  public async generateStudyGuide(
    notebookId: string,
    sourceIds?: string[] | null,
    language = 'en',
  ): Promise<GenerationStatus> {
    return this.generateReport(notebookId, ReportFormat.STUDY_GUIDE, sourceIds, language);
  }

  public async generateQuiz(
    notebookId: string,
    sourceIds?: string[] | null,
    instructions?: string | null,
    quantity?: QuizQuantity | null,
    difficulty?: QuizDifficulty | null,
  ): Promise<GenerationStatus> {
    let ids = sourceIds;
    if (!ids) {
      ids = await this.core.getSourceIds(notebookId);
    }

    const sourceIdsTriple = ids.length > 0 ? ids.map((sid) => [[sid]]) : [];
    const quantityCode = quantity ?? null;
    const difficultyCode = difficulty ?? null;

    const params = [
      [2],
      notebookId,
      [
        null,
        null,
        4,
        sourceIdsTriple,
        null,
        null,
        null,
        null,
        null,
        [
          null,
          [2, null, instructions ?? null, null, null, null, null, [quantityCode, difficultyCode]],
        ],
      ],
    ];

    return this.callGenerate(notebookId, params);
  }

  public async generateFlashcards(
    notebookId: string,
    sourceIds?: string[] | null,
    instructions?: string | null,
    quantity?: QuizQuantity | null,
    difficulty?: QuizDifficulty | null,
  ): Promise<GenerationStatus> {
    let ids = sourceIds;
    if (!ids) {
      ids = await this.core.getSourceIds(notebookId);
    }

    const sourceIdsTriple = ids.length > 0 ? ids.map((sid) => [[sid]]) : [];
    const quantityCode = quantity ?? null;
    const difficultyCode = difficulty ?? null;

    const params = [
      [2],
      notebookId,
      [
        null,
        null,
        4,
        sourceIdsTriple,
        null,
        null,
        null,
        null,
        null,
        [null, [1, null, instructions ?? null, null, null, null, [difficultyCode, quantityCode]]],
      ],
    ];

    return this.callGenerate(notebookId, params);
  }

  public async generateInfographic(
    notebookId: string,
    sourceIds?: string[] | null,
    language = 'en',
    instructions?: string | null,
    orientation?: InfographicOrientation | null,
    detailLevel?: InfographicDetail | null,
  ): Promise<GenerationStatus> {
    let ids = sourceIds;
    if (!ids) {
      ids = await this.core.getSourceIds(notebookId);
    }

    const sourceIdsTriple = ids.length > 0 ? ids.map((sid) => [[sid]]) : [];
    const orientationCode = orientation ?? null;
    const detailCode = detailLevel ?? null;

    const params = [
      [2],
      notebookId,
      [
        null,
        null,
        7,
        sourceIdsTriple,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        [[instructions ?? null, language, null, orientationCode, detailCode]],
      ],
    ];

    return this.callGenerate(notebookId, params);
  }

  public async generateSlideDeck(
    notebookId: string,
    sourceIds?: string[] | null,
    language = 'en',
    instructions?: string | null,
    slideFormat?: SlideDeckFormat | null,
    slideLength?: SlideDeckLength | null,
  ): Promise<GenerationStatus> {
    let ids = sourceIds;
    if (!ids) {
      ids = await this.core.getSourceIds(notebookId);
    }

    const sourceIdsTriple = ids.length > 0 ? ids.map((sid) => [[sid]]) : [];
    const formatCode = slideFormat ?? null;
    const lengthCode = slideLength ?? null;

    const params = [
      [2],
      notebookId,
      [
        null,
        null,
        8,
        sourceIdsTriple,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        [[instructions ?? null, language, formatCode, lengthCode]],
      ],
    ];

    return this.callGenerate(notebookId, params);
  }

  public async generateDataTable(
    notebookId: string,
    sourceIds?: string[] | null,
    language = 'en',
    instructions?: string | null,
  ): Promise<GenerationStatus> {
    let ids = sourceIds;
    if (!ids) {
      ids = await this.core.getSourceIds(notebookId);
    }

    const sourceIdsTriple = ids.length > 0 ? ids.map((sid) => [[sid]]) : [];

    const params = [
      [2],
      notebookId,
      [
        null,
        null,
        9,
        sourceIdsTriple,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        [null, [instructions ?? null, language]],
      ],
    ];

    return this.callGenerate(notebookId, params);
  }

  public async generateMindMap(
    notebookId: string,
    sourceIds?: string[] | null,
  ): Promise<Record<string, unknown>> {
    let ids = sourceIds;
    if (!ids) {
      ids = await this.core.getSourceIds(notebookId);
    }

    const sourceIdsNested = ids.length > 0 ? ids.map((sid) => [[sid]]) : [];

    const params = [
      sourceIdsNested,
      null,
      null,
      null,
      null,
      ['interactive_mindmap', [['[CONTEXT]', '']], ''],
      null,
      [2, null, [1]],
    ];

    const result = await this.core.rpcCall(
      RPCMethod.GENERATE_MIND_MAP,
      params,
      `/notebook/${notebookId}`,
      true,
    );

    if (
      Array.isArray(result) &&
      result.length > 0 &&
      Array.isArray(result[0]) &&
      result[0].length > 0
    ) {
      const mindMapJson = result[0][0];

      let mindMapData: unknown = null;
      let normalizedJson = '';

      if (typeof mindMapJson === 'string') {
        normalizedJson = mindMapJson;
        try {
          mindMapData = JSON.parse(mindMapJson);
        } catch {
          mindMapData = mindMapJson;
        }
      } else {
        mindMapData = mindMapJson;
        normalizedJson = JSON.stringify(mindMapJson);
      }

      let title = 'Mind Map';
      if (
        mindMapData &&
        typeof mindMapData === 'object' &&
        typeof (mindMapData as Record<string, unknown>).name === 'string'
      ) {
        title = (mindMapData as Record<string, unknown>).name as string;
      }

      const note = await this.notes.create(notebookId, title, normalizedJson);
      return {
        mindMap: mindMapData,
        noteId: note.id,
      };
    }

    return {
      mindMap: null,
      noteId: null,
    };
  }

  public async downloadAudio(
    notebookId: string,
    outputPath: string,
    artifactId?: string | null,
  ): Promise<string> {
    const artifactsData = await this.listRaw(notebookId);

    const candidates = artifactsData.filter(
      (artifact) =>
        Array.isArray(artifact) &&
        artifact.length > 4 &&
        artifact[2] === ArtifactTypeCode.AUDIO &&
        artifact[4] === ArtifactStatus.COMPLETED,
    ) as unknown[][];

    let audioArtifact: unknown[] | undefined;
    if (artifactId) {
      audioArtifact = candidates.find((artifact) => artifact[0] === artifactId);
      if (!audioArtifact) {
        throw new ArtifactNotReadyError('audio', { artifactId });
      }
    } else {
      audioArtifact = candidates[0];
    }

    if (!audioArtifact) {
      throw new ArtifactNotReadyError('audio');
    }

    try {
      const metadata = audioArtifact[6];
      if (!Array.isArray(metadata) || metadata.length <= 5 || !Array.isArray(metadata[5])) {
        throw new ArtifactParseError('audio', {
          artifactId: artifactId ?? null,
          details: 'Invalid audio metadata structure',
        });
      }

      const mediaList = metadata[5] as unknown[];
      if (mediaList.length === 0) {
        throw new ArtifactParseError('audio', {
          artifactId: artifactId ?? null,
          details: 'No media URLs found',
        });
      }

      let url: string | null = null;
      for (const item of mediaList) {
        if (Array.isArray(item) && typeof item[0] === 'string' && item[2] === 'audio/mp4') {
          url = item[0];
          break;
        }
      }

      if (!url && Array.isArray(mediaList[0]) && typeof mediaList[0][0] === 'string') {
        url = mediaList[0][0];
      }

      if (!url) {
        throw new ArtifactDownloadError('audio', {
          artifactId: artifactId ?? null,
          details: 'Could not extract download URL',
        });
      }

      return this.downloadUrl(url, outputPath);
    } catch (error) {
      if (error instanceof ArtifactParseError || error instanceof ArtifactDownloadError) {
        throw error;
      }

      throw new ArtifactParseError('audio', {
        artifactId: artifactId ?? null,
        details: `Failed to parse audio artifact structure: ${String(error)}`,
        cause: error instanceof Error ? error : null,
      });
    }
  }

  public async downloadVideo(
    notebookId: string,
    outputPath: string,
    artifactId?: string | null,
  ): Promise<string> {
    const artifactsData = await this.listRaw(notebookId);

    const candidates = artifactsData.filter(
      (artifact) =>
        Array.isArray(artifact) &&
        artifact.length > 4 &&
        artifact[2] === ArtifactTypeCode.VIDEO &&
        artifact[4] === ArtifactStatus.COMPLETED,
    ) as unknown[][];

    let videoArtifact: unknown[] | undefined;
    if (artifactId) {
      videoArtifact = candidates.find((artifact) => artifact[0] === artifactId);
      if (!videoArtifact) {
        throw new ArtifactNotReadyError('video', { artifactId });
      }
    } else {
      videoArtifact = candidates[0];
    }

    if (!videoArtifact) {
      throw new ArtifactNotReadyError('video_overview');
    }

    try {
      if (videoArtifact.length <= 8 || !Array.isArray(videoArtifact[8])) {
        throw new ArtifactParseError('video_artifact', { details: 'Invalid structure' });
      }

      const metadata = videoArtifact[8] as unknown[];

      let mediaList: unknown[] | null = null;
      for (const item of metadata) {
        if (
          Array.isArray(item) &&
          item.length > 0 &&
          Array.isArray(item[0]) &&
          item[0].length > 0 &&
          typeof item[0][0] === 'string' &&
          item[0][0].startsWith('http')
        ) {
          mediaList = item as unknown[];
          break;
        }
      }

      if (!mediaList) {
        throw new ArtifactParseError('media', { details: 'No media URLs found' });
      }

      let url: string | null = null;
      for (const item of mediaList) {
        if (Array.isArray(item) && typeof item[0] === 'string' && item[2] === 'video/mp4') {
          url = item[0];
          if (item[1] === 4) {
            break;
          }
        }
      }

      if (!url && Array.isArray(mediaList[0]) && typeof mediaList[0][0] === 'string') {
        url = mediaList[0][0];
      }

      if (!url) {
        throw new ArtifactDownloadError('media', { details: 'Could not extract download URL' });
      }

      return this.downloadUrl(url, outputPath);
    } catch (error) {
      if (error instanceof ArtifactParseError || error instanceof ArtifactDownloadError) {
        throw error;
      }

      throw new ArtifactParseError('video_artifact', {
        details: `Failed to parse structure: ${String(error)}`,
        cause: error instanceof Error ? error : null,
      });
    }
  }

  public async downloadInfographic(
    notebookId: string,
    outputPath: string,
    artifactId?: string | null,
  ): Promise<string> {
    const artifactsData = await this.listRaw(notebookId);

    const candidates = artifactsData.filter(
      (artifact) =>
        Array.isArray(artifact) &&
        artifact.length > 4 &&
        artifact[2] === ArtifactTypeCode.INFOGRAPHIC &&
        artifact[4] === ArtifactStatus.COMPLETED,
    ) as unknown[][];

    let infoArtifact: unknown[] | undefined;
    if (artifactId) {
      infoArtifact = candidates.find((artifact) => artifact[0] === artifactId);
      if (!infoArtifact) {
        throw new ArtifactNotReadyError('infographic', { artifactId });
      }
    } else {
      infoArtifact = candidates[0];
    }

    if (!infoArtifact) {
      throw new ArtifactNotReadyError('infographic');
    }

    try {
      let metadata: unknown[] | null = null;
      for (let i = infoArtifact.length - 1; i >= 0; i -= 1) {
        const item = infoArtifact[i];
        if (!Array.isArray(item) || item.length === 0 || !Array.isArray(item[0])) {
          continue;
        }

        if (
          item.length > 2 &&
          Array.isArray(item[2]) &&
          item[2].length > 0 &&
          Array.isArray(item[2][0]) &&
          item[2][0].length > 1
        ) {
          const imgData = item[2][0][1];
          if (
            Array.isArray(imgData) &&
            typeof imgData[0] === 'string' &&
            imgData[0].startsWith('http')
          ) {
            metadata = item;
            break;
          }
        }
      }

      if (!metadata) {
        throw new ArtifactParseError('infographic', { details: 'Could not find metadata' });
      }

      const url = (((metadata[2] as unknown[])[0] as unknown[])[1] as unknown[])[0];
      if (typeof url !== 'string') {
        throw new ArtifactDownloadError('infographic', {
          details: 'Could not extract download URL',
        });
      }

      return this.downloadUrl(url, outputPath);
    } catch (error) {
      if (error instanceof ArtifactParseError || error instanceof ArtifactDownloadError) {
        throw error;
      }

      throw new ArtifactParseError('infographic', {
        details: `Failed to parse structure: ${String(error)}`,
        cause: error instanceof Error ? error : null,
      });
    }
  }

  public async downloadSlideDeck(
    notebookId: string,
    outputPath: string,
    artifactId?: string | null,
  ): Promise<string> {
    const artifactsData = await this.listRaw(notebookId);

    const candidates = artifactsData.filter(
      (artifact) =>
        Array.isArray(artifact) &&
        artifact.length > 4 &&
        artifact[2] === ArtifactTypeCode.SLIDE_DECK &&
        artifact[4] === ArtifactStatus.COMPLETED,
    ) as unknown[][];

    let slideArtifact: unknown[] | undefined;
    if (artifactId) {
      slideArtifact = candidates.find((artifact) => artifact[0] === artifactId);
      if (!slideArtifact) {
        throw new ArtifactNotReadyError('slide_deck', { artifactId });
      }
    } else {
      slideArtifact = candidates[0];
    }

    if (!slideArtifact) {
      throw new ArtifactNotReadyError('slide_deck');
    }

    try {
      if (
        slideArtifact.length <= 16 ||
        !Array.isArray(slideArtifact[16]) ||
        slideArtifact[16].length < 4
      ) {
        throw new ArtifactParseError('slide_deck_metadata', { details: 'Invalid structure' });
      }

      const pdfUrl = slideArtifact[16][3];
      if (typeof pdfUrl !== 'string' || !pdfUrl.startsWith('http')) {
        throw new ArtifactDownloadError('slide_deck', {
          details: 'Could not find PDF download URL',
        });
      }

      return this.downloadUrl(pdfUrl, outputPath);
    } catch (error) {
      if (error instanceof ArtifactParseError || error instanceof ArtifactDownloadError) {
        throw error;
      }

      throw new ArtifactParseError('slide_deck', {
        details: `Failed to parse structure: ${String(error)}`,
        cause: error instanceof Error ? error : null,
      });
    }
  }

  private async getArtifactContent(notebookId: string, artifactId: string): Promise<string | null> {
    const result = await this.core.rpcCall(
      RPCMethod.GET_INTERACTIVE_HTML,
      [artifactId],
      `/notebook/${notebookId}`,
      true,
    );

    if (
      Array.isArray(result) &&
      result.length > 0 &&
      Array.isArray(result[0]) &&
      result[0].length > 9 &&
      Array.isArray(result[0][9]) &&
      typeof result[0][9][0] === 'string'
    ) {
      return result[0][9][0];
    }

    return null;
  }

  private async downloadInteractiveArtifact(
    notebookId: string,
    outputPath: string,
    artifactId: string | null | undefined,
    outputFormat: string,
    artifactType: 'quiz' | 'flashcards',
  ): Promise<string> {
    const validFormats = ['json', 'markdown', 'html'];
    if (!validFormats.includes(outputFormat)) {
      throw new ValidationError(
        `Invalid outputFormat: '${outputFormat}'. Use one of: ${validFormats.join(', ')}`,
      );
    }

    const isQuiz = artifactType === 'quiz';
    const defaultTitle = isQuiz ? 'Untitled Quiz' : 'Untitled Flashcards';

    const artifacts = isQuiz
      ? await this.listQuizzes(notebookId)
      : await this.listFlashcards(notebookId);
    const completed = artifacts.filter((artifact) => artifact.isCompleted);
    if (completed.length === 0) {
      throw new ArtifactNotReadyError(artifactType);
    }

    completed.sort(
      (left, right) =>
        (right.createdAt ? right.createdAt.getTime() : 0) -
        (left.createdAt ? left.createdAt.getTime() : 0),
    );

    let artifact = completed[0];
    if (artifactId) {
      artifact = completed.find((entry) => entry.id === artifactId) ?? artifact;
      if (!artifact || artifact.id !== artifactId) {
        throw new ArtifactNotFoundError(artifactId, artifactType);
      }
    }

    const htmlContent = await this.getArtifactContent(notebookId, artifact.id);
    if (!htmlContent) {
      throw new ArtifactDownloadError(artifactType, { details: 'Failed to fetch content' });
    }

    let appData: Record<string, unknown>;
    try {
      appData = extractAppData(htmlContent);
    } catch (error) {
      throw new ArtifactParseError(artifactType, {
        details: `Failed to parse content: ${String(error)}`,
        cause: error instanceof Error ? error : null,
      });
    }

    const title = artifact.title || defaultTitle;
    const content = this.formatInteractiveContent(
      appData,
      title,
      outputFormat,
      htmlContent,
      isQuiz,
    );

    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, content, 'utf-8');
    return outputPath;
  }

  private formatInteractiveContent(
    appData: Record<string, unknown>,
    title: string,
    outputFormat: string,
    htmlContent: string,
    isQuiz: boolean,
  ): string {
    if (outputFormat === 'html') {
      return htmlContent;
    }

    if (isQuiz) {
      const questions = Array.isArray(appData.quiz)
        ? (appData.quiz as Array<Record<string, unknown>>)
        : [];
      if (outputFormat === 'markdown') {
        return formatQuizMarkdown(title, questions);
      }

      return JSON.stringify({ title, questions }, null, 2);
    }

    const cards = Array.isArray(appData.flashcards)
      ? (appData.flashcards as Array<Record<string, unknown>>)
      : [];

    if (outputFormat === 'markdown') {
      return formatFlashcardsMarkdown(title, cards);
    }

    const normalized = cards.map((card) => ({
      front: typeof card.f === 'string' ? card.f : '',
      back: typeof card.b === 'string' ? card.b : '',
    }));

    return JSON.stringify({ title, cards: normalized }, null, 2);
  }

  public async downloadReport(
    notebookId: string,
    outputPath: string,
    artifactId?: string | null,
  ): Promise<string> {
    const artifactsData = await this.listRaw(notebookId);

    const candidates = artifactsData.filter(
      (artifact) =>
        Array.isArray(artifact) &&
        artifact.length > 7 &&
        artifact[2] === ArtifactTypeCode.REPORT &&
        artifact[4] === ArtifactStatus.COMPLETED,
    ) as unknown[][];

    const reportArtifact = this.selectArtifact(candidates, artifactId, 'Report', 'report');

    try {
      const contentWrapper = reportArtifact[7];
      const markdownContent =
        Array.isArray(contentWrapper) && contentWrapper.length > 0
          ? contentWrapper[0]
          : contentWrapper;

      if (typeof markdownContent !== 'string') {
        throw new ArtifactParseError('report_content', { details: 'Invalid structure' });
      }

      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, markdownContent, 'utf-8');
      return outputPath;
    } catch (error) {
      if (error instanceof ArtifactParseError) {
        throw error;
      }

      throw new ArtifactParseError('report', {
        details: `Failed to parse structure: ${String(error)}`,
        cause: error instanceof Error ? error : null,
      });
    }
  }

  public async downloadMindMap(
    notebookId: string,
    outputPath: string,
    artifactId?: string | null,
  ): Promise<string> {
    const mindMaps = await this.notes.listMindMaps(notebookId);
    if (mindMaps.length === 0) {
      throw new ArtifactNotReadyError('mind_map');
    }

    let mindMap = mindMaps[0];
    if (artifactId) {
      const matched = mindMaps.find((entry) => Array.isArray(entry) && entry[0] === artifactId);
      if (!matched) {
        throw new ArtifactNotFoundError(artifactId, 'mind_map');
      }
      mindMap = matched;
    }

    try {
      if (
        !Array.isArray(mindMap) ||
        !Array.isArray(mindMap[1]) ||
        typeof mindMap[1][1] !== 'string'
      ) {
        throw new ArtifactParseError('mind_map_content', { details: 'Invalid structure' });
      }

      const jsonData = JSON.parse(mindMap[1][1]);
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, JSON.stringify(jsonData, null, 2), 'utf-8');
      return outputPath;
    } catch (error) {
      if (error instanceof ArtifactParseError) {
        throw error;
      }

      throw new ArtifactParseError('mind_map', {
        details: `Failed to parse structure: ${String(error)}`,
        cause: error instanceof Error ? error : null,
      });
    }
  }

  public async downloadDataTable(
    notebookId: string,
    outputPath: string,
    artifactId?: string | null,
  ): Promise<string> {
    const artifactsData = await this.listRaw(notebookId);

    const candidates = artifactsData.filter(
      (artifact) =>
        Array.isArray(artifact) &&
        artifact.length > 18 &&
        artifact[2] === ArtifactTypeCode.DATA_TABLE &&
        artifact[4] === ArtifactStatus.COMPLETED,
    ) as unknown[][];

    const tableArtifact = this.selectArtifact(candidates, artifactId, 'Data table', 'data table');

    try {
      if (!Array.isArray(tableArtifact[18])) {
        throw new ArtifactParseError('data_table', { details: 'Invalid data table structure' });
      }

      const [headers, rows] = parseDataTable(tableArtifact[18] as unknown[]);

      await mkdir(path.dirname(outputPath), { recursive: true });

      const csvLines: string[] = [];
      const toCsvCell = (value: string): string => {
        if (value.includes(',') || value.includes('"') || value.includes('\n')) {
          return `"${value.replaceAll('"', '""')}"`;
        }
        return value;
      };

      csvLines.push(headers.map((header) => toCsvCell(header)).join(','));
      for (const row of rows) {
        csvLines.push(row.map((cell) => toCsvCell(cell)).join(','));
      }

      await writeFile(outputPath, `\uFEFF${csvLines.join('\n')}`, 'utf-8');
      return outputPath;
    } catch (error) {
      if (error instanceof ArtifactParseError) {
        throw error;
      }

      throw new ArtifactParseError('data_table', {
        details: `Failed to parse structure: ${String(error)}`,
        cause: error instanceof Error ? error : null,
      });
    }
  }

  public async downloadQuiz(
    notebookId: string,
    outputPath: string,
    artifactId?: string | null,
    outputFormat = 'json',
  ): Promise<string> {
    return this.downloadInteractiveArtifact(
      notebookId,
      outputPath,
      artifactId,
      outputFormat,
      'quiz',
    );
  }

  public async downloadFlashcards(
    notebookId: string,
    outputPath: string,
    artifactId?: string | null,
    outputFormat = 'json',
  ): Promise<string> {
    return this.downloadInteractiveArtifact(
      notebookId,
      outputPath,
      artifactId,
      outputFormat,
      'flashcards',
    );
  }

  public async delete(notebookId: string, artifactId: string): Promise<boolean> {
    console.debug(`Deleting artifact ${artifactId} from notebook ${notebookId}`);
    const params = [[2], artifactId];
    await this.core.rpcCall(RPCMethod.DELETE_ARTIFACT, params, `/notebook/${notebookId}`, true);
    return true;
  }

  public async rename(notebookId: string, artifactId: string, newTitle: string): Promise<void> {
    const params = [[artifactId, newTitle], [['title']]];
    await this.core.rpcCall(RPCMethod.RENAME_ARTIFACT, params, `/notebook/${notebookId}`, true);
  }

  public async pollStatus(notebookId: string, taskId: string): Promise<GenerationStatus> {
    const artifactsData = await this.listRaw(notebookId);

    for (const artifact of artifactsData) {
      if (!Array.isArray(artifact) || artifact.length === 0 || artifact[0] !== taskId) {
        continue;
      }

      let statusCode = typeof artifact[4] === 'number' ? artifact[4] : 0;
      const artifactType = typeof artifact[2] === 'number' ? artifact[2] : 0;

      if (statusCode === ArtifactStatus.COMPLETED && !this.isMediaReady(artifact, artifactType)) {
        console.debug(
          `Artifact ${taskId} (type=${this.getArtifactTypeName(artifactType)}) status=COMPLETED but media not ready, continuing poll`,
        );
        statusCode = ArtifactStatus.PROCESSING;
      }

      return createGenerationStatus({
        taskId,
        status: artifactStatusToStr(statusCode),
      });
    }

    return createGenerationStatus({
      taskId,
      status: 'pending',
    });
  }

  public async waitForCompletion(
    notebookId: string,
    taskId: string,
    initialInterval = 2,
    maxInterval = 10,
    timeout = 300,
    pollInterval?: number,
  ): Promise<GenerationStatus> {
    let currentInterval = pollInterval ?? initialInterval;
    if (pollInterval !== undefined) {
      console.warn('pollInterval is deprecated, use initialInterval instead');
    }

    const start = performance.now();

    while (true) {
      const status = await this.pollStatus(notebookId, taskId);
      if (status.isComplete || status.isFailed) {
        return status;
      }

      const elapsed = (performance.now() - start) / 1000;
      if (elapsed > timeout) {
        throw new Error(`Task ${taskId} timed out after ${timeout}s`);
      }

      const remaining = timeout - elapsed;
      const sleepDuration = Math.min(currentInterval, remaining);
      if (sleepDuration > 0) {
        await sleep(Math.max(1, Math.floor(sleepDuration * 1000)));
      }

      currentInterval = Math.min(currentInterval * 2, maxInterval);
    }
  }

  public async exportReport(
    notebookId: string,
    artifactId: string,
    title = 'Export',
    exportType: ExportType = ExportType.DOCS,
  ): Promise<unknown> {
    const params = [null, artifactId, null, title, Number(exportType)];
    return this.core.rpcCall(RPCMethod.EXPORT_ARTIFACT, params, `/notebook/${notebookId}`, true);
  }

  public async exportDataTable(
    notebookId: string,
    artifactId: string,
    title = 'Export',
  ): Promise<unknown> {
    const params = [null, artifactId, null, title, Number(ExportType.SHEETS)];
    return this.core.rpcCall(RPCMethod.EXPORT_ARTIFACT, params, `/notebook/${notebookId}`, true);
  }

  public async export(
    notebookId: string,
    artifactId: string | null,
    content: string | null,
    title = 'Export',
    exportType: ExportType = ExportType.DOCS,
  ): Promise<unknown> {
    const params = [null, artifactId, content, title, Number(exportType)];
    return this.core.rpcCall(RPCMethod.EXPORT_ARTIFACT, params, `/notebook/${notebookId}`, true);
  }

  public async suggestReports(
    notebookId: string,
  ): Promise<Array<ReturnType<typeof ReportSuggestion.fromApiResponse>>> {
    const params = [[2], notebookId];
    const result = await this.core.rpcCall(
      RPCMethod.GET_SUGGESTED_REPORTS,
      params,
      `/notebook/${notebookId}`,
      true,
    );

    const suggestions: Array<ReturnType<typeof ReportSuggestion.fromApiResponse>> = [];

    if (Array.isArray(result) && result.length > 0) {
      const items = Array.isArray(result[0]) ? (result[0] as unknown[]) : result;
      for (const item of items) {
        if (!Array.isArray(item) || item.length < 5) {
          continue;
        }

        suggestions.push({
          title: typeof item[0] === 'string' ? item[0] : '',
          description: typeof item[1] === 'string' ? item[1] : '',
          prompt: typeof item[4] === 'string' ? item[4] : '',
          audienceLevel: typeof item[5] === 'number' ? item[5] : 2,
        });
      }
    }

    return suggestions;
  }

  private async callGenerate(notebookId: string, params: unknown[]): Promise<GenerationStatus> {
    const artifactType =
      Array.isArray(params[2]) && typeof params[2][2] !== 'undefined'
        ? String(params[2][2])
        : 'unknown';

    console.debug(`Generating artifact type=${artifactType} in notebook ${notebookId}`);

    try {
      const result = await this.core.rpcCall(
        RPCMethod.CREATE_ARTIFACT,
        params,
        `/notebook/${notebookId}`,
        true,
      );

      return this.parseGenerationResult(result);
    } catch (error) {
      if (error instanceof RPCError && error.rpcCode === 'USER_DISPLAYABLE_ERROR') {
        return createGenerationStatus({
          taskId: '',
          status: 'failed',
          error: error.message,
          errorCode: String(error.rpcCode),
        });
      }

      throw error;
    }
  }

  private async listRaw(notebookId: string): Promise<unknown[][]> {
    const params = [[2], notebookId, 'NOT artifact.status = "ARTIFACT_STATUS_SUGGESTED"'];
    const result = await this.core.rpcCall(
      RPCMethod.LIST_ARTIFACTS,
      params,
      `/notebook/${notebookId}`,
      true,
    );

    if (Array.isArray(result) && result.length > 0) {
      const data = Array.isArray(result[0]) ? result[0] : result;
      return data.filter((item): item is unknown[] => Array.isArray(item));
    }

    return [];
  }

  private selectArtifact(
    candidates: unknown[][],
    artifactId: string | null | undefined,
    typeName: string,
    typeNameLower: string,
  ): unknown[] {
    if (artifactId) {
      const artifact = candidates.find((candidate) => candidate[0] === artifactId);
      if (!artifact) {
        throw new ArtifactNotReadyError(typeName.toLowerCase().replaceAll(' ', '_'), {
          artifactId,
        });
      }

      return artifact;
    }

    if (candidates.length === 0) {
      throw new ArtifactNotReadyError(typeNameLower);
    }

    candidates.sort((left, right) => {
      const leftTs = Array.isArray(left[15]) && typeof left[15][0] === 'number' ? left[15][0] : 0;
      const rightTs =
        Array.isArray(right[15]) && typeof right[15][0] === 'number' ? right[15][0] : 0;
      return rightTs - leftTs;
    });

    return candidates[0] as unknown[];
  }

  private async fetchWithCookieRedirects(
    url: string,
    opts: {
      method?: string;
      headers?: Record<string, string>;
      body?: BodyInit | null;
      timeoutMs?: number;
      maxRedirects?: number;
    } = {},
  ): Promise<Response> {
    const method = opts.method ?? 'GET';
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const maxRedirects = opts.maxRedirects ?? 10;

    let currentUrl = url;
    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
      const response = await fetchWithTimeout(
        currentUrl,
        {
          method,
          headers: opts.headers,
          body: opts.body ?? undefined,
          redirect: 'manual',
        },
        timeoutMs,
      );

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) {
          return response;
        }

        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      return response;
    }

    throw new ArtifactDownloadError('media', {
      details: 'Too many redirects while downloading media',
    });
  }

  private async downloadUrl(url: string, outputPath: string): Promise<string> {
    await mkdir(path.dirname(outputPath), { recursive: true });

    const tempFile = `${outputPath}.tmp`;

    try {
      const response = await this.fetchWithCookieRedirects(url, {
        headers: {
          Cookie: this.core.auth.cookieHeader,
        },
        timeoutMs: 60_000,
      });

      if (!response.ok) {
        throw new ArtifactDownloadError('media', {
          details: `HTTP ${response.status} ${response.statusText}`,
        });
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('text/html')) {
        throw new ArtifactDownloadError('media', {
          details:
            'Download failed: received HTML instead of media file. Authentication may have expired. Re-authenticate and retry.',
        });
      }

      // Stream directly to disk to avoid OOM on large media files (videos can be >100MB)
      const body = response.body;
      if (!body) {
        throw new ArtifactDownloadError('media', {
          details: 'Response body is null',
        });
      }

      const { createWriteStream } = await import('node:fs');
      const { Writable } = await import('node:stream');
      const fileStream = createWriteStream(tempFile);
      const writableStream = Writable.toWeb(fileStream) as WritableStream<Uint8Array>;
      await body.pipeTo(writableStream);

      await rename(tempFile, outputPath);
      return outputPath;
    } catch (error) {
      await rm(tempFile, { force: true });

      if (error instanceof ArtifactDownloadError) {
        throw error;
      }

      throw new ArtifactDownloadError('media', {
        details: `Download failed: ${String(error)}`,
        cause: error instanceof Error ? error : null,
      });
    }
  }

  private parseGenerationResult(result: unknown): GenerationStatus {
    if (
      Array.isArray(result) &&
      result.length > 0 &&
      Array.isArray(result[0]) &&
      result[0].length > 0
    ) {
      const artifactData = result[0] as unknown[];
      const artifactId = typeof artifactData[0] === 'string' ? artifactData[0] : null;
      const statusCode = typeof artifactData[4] === 'number' ? artifactData[4] : null;

      if (artifactId) {
        return createGenerationStatus({
          taskId: artifactId,
          status: statusCode === null ? 'pending' : artifactStatusToStr(statusCode),
        });
      }
    }

    return createGenerationStatus({
      taskId: '',
      status: 'failed',
      error: 'Generation failed - no artifact_id returned',
    });
  }

  private getArtifactTypeName(artifactType: number): string {
    return ArtifactTypeCode[artifactType] ?? String(artifactType);
  }

  private isValidMediaUrl(value: unknown): boolean {
    return (
      typeof value === 'string' && (value.startsWith('http://') || value.startsWith('https://'))
    );
  }

  private findInfographicUrl(artifact: unknown[]): string | null {
    for (let i = artifact.length - 1; i >= 0; i -= 1) {
      const item = artifact[i];
      if (
        !Array.isArray(item) ||
        item.length <= 2 ||
        !Array.isArray(item[2]) ||
        item[2].length === 0
      ) {
        continue;
      }

      const firstContent = item[2][0];
      if (!Array.isArray(firstContent) || firstContent.length <= 1) {
        continue;
      }

      const imgData = firstContent[1];
      if (Array.isArray(imgData) && imgData.length > 0 && this.isValidMediaUrl(imgData[0])) {
        return imgData[0];
      }
    }

    return null;
  }

  private isMediaReady(artifact: unknown[], artifactType: number): boolean {
    try {
      if (artifactType === ArtifactTypeCode.AUDIO) {
        if (artifact.length > 6 && Array.isArray(artifact[6]) && artifact[6].length > 5) {
          const mediaList = artifact[6][5];
          if (
            Array.isArray(mediaList) &&
            mediaList.length > 0 &&
            Array.isArray(mediaList[0]) &&
            mediaList[0].length > 0
          ) {
            return this.isValidMediaUrl(mediaList[0][0]);
          }
        }

        return false;
      }

      if (artifactType === ArtifactTypeCode.VIDEO) {
        if (artifact.length > 8 && Array.isArray(artifact[8])) {
          return artifact[8].some(
            (item) => Array.isArray(item) && item.length > 0 && this.isValidMediaUrl(item[0]),
          );
        }

        return false;
      }

      if (artifactType === ArtifactTypeCode.INFOGRAPHIC) {
        return this.findInfographicUrl(artifact) !== null;
      }

      if (artifactType === ArtifactTypeCode.SLIDE_DECK) {
        return (
          artifact.length > 16 &&
          Array.isArray(artifact[16]) &&
          artifact[16].length > 3 &&
          this.isValidMediaUrl(artifact[16][3])
        );
      }

      return true;
    } catch (error) {
      const isMedia = MEDIA_ARTIFACT_TYPES.has(artifactType);
      console.debug(
        `Unexpected artifact structure for type ${artifactType} (media=${String(isMedia)}): ${String(error)}`,
      );
      return !isMedia;
    }
  }
}
