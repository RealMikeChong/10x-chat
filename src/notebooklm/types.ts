import {
  ArtifactDownloadError,
  ArtifactError,
  ArtifactNotFoundError,
  ArtifactNotReadyError,
  ArtifactParseError,
  SourceAddError,
  SourceError,
  SourceNotFoundError,
  SourceProcessingError,
  SourceTimeoutError,
} from './errors.js';
import {
  ArtifactStatus,
  AudioFormat,
  AudioLength,
  artifactStatusToStr,
  ChatGoal,
  ChatResponseLength,
  DriveMimeType,
  ExportType,
  InfographicDetail,
  InfographicOrientation,
  QuizDifficulty,
  QuizQuantity,
  ReportFormat,
  ShareAccess,
  SharePermission,
  ShareViewLevel,
  SlideDeckFormat,
  SlideDeckLength,
  SourceStatus,
  sourceStatusToStr,
  VideoFormat,
  VideoStyle,
} from './rpc/types.js';

export {
  ArtifactDownloadError,
  ArtifactError,
  ArtifactNotFoundError,
  ArtifactNotReadyError,
  ArtifactParseError,
  SourceAddError,
  SourceError,
  SourceNotFoundError,
  SourceProcessingError,
  SourceTimeoutError,
};

export {
  ArtifactStatus,
  AudioFormat,
  AudioLength,
  ChatGoal,
  ChatResponseLength,
  DriveMimeType,
  ExportType,
  InfographicDetail,
  InfographicOrientation,
  QuizDifficulty,
  QuizQuantity,
  ReportFormat,
  ShareAccess,
  SharePermission,
  ShareViewLevel,
  SlideDeckFormat,
  SlideDeckLength,
  SourceStatus,
  VideoFormat,
  VideoStyle,
  artifactStatusToStr,
  sourceStatusToStr,
};

export class UnknownTypeWarning extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'UnknownTypeWarning';
  }
}

export enum SourceType {
  GOOGLE_DOCS = 'google_docs',
  GOOGLE_SLIDES = 'google_slides',
  GOOGLE_SPREADSHEET = 'google_spreadsheet',
  PDF = 'pdf',
  PASTED_TEXT = 'pasted_text',
  WEB_PAGE = 'web_page',
  GOOGLE_DRIVE_AUDIO = 'google_drive_audio',
  GOOGLE_DRIVE_VIDEO = 'google_drive_video',
  YOUTUBE = 'youtube',
  MARKDOWN = 'markdown',
  DOCX = 'docx',
  CSV = 'csv',
  IMAGE = 'image',
  MEDIA = 'media',
  UNKNOWN = 'unknown',
}

export enum ArtifactType {
  AUDIO = 'audio',
  VIDEO = 'video',
  REPORT = 'report',
  QUIZ = 'quiz',
  FLASHCARDS = 'flashcards',
  MIND_MAP = 'mind_map',
  INFOGRAPHIC = 'infographic',
  SLIDE_DECK = 'slide_deck',
  DATA_TABLE = 'data_table',
  UNKNOWN = 'unknown',
}

const warnedSourceTypes = new Set<number>();
const warnedArtifactTypes = new Set<string>();

const SOURCE_TYPE_CODE_MAP: Record<number, SourceType> = {
  1: SourceType.GOOGLE_DOCS,
  2: SourceType.GOOGLE_SLIDES,
  3: SourceType.PDF,
  4: SourceType.PASTED_TEXT,
  5: SourceType.WEB_PAGE,
  8: SourceType.MARKDOWN,
  9: SourceType.YOUTUBE,
  10: SourceType.MEDIA,
  11: SourceType.DOCX,
  13: SourceType.IMAGE,
  14: SourceType.GOOGLE_SPREADSHEET,
  16: SourceType.CSV,
};

const ARTIFACT_TYPE_CODE_MAP: Record<number, ArtifactType> = {
  1: ArtifactType.AUDIO,
  2: ArtifactType.REPORT,
  3: ArtifactType.VIDEO,
  5: ArtifactType.MIND_MAP,
  7: ArtifactType.INFOGRAPHIC,
  8: ArtifactType.SLIDE_DECK,
  9: ArtifactType.DATA_TABLE,
};

const SOURCE_TYPE_COMPAT_MAP: Record<SourceType, string> = {
  [SourceType.GOOGLE_DOCS]: 'text',
  [SourceType.GOOGLE_SLIDES]: 'text',
  [SourceType.GOOGLE_SPREADSHEET]: 'text',
  [SourceType.PDF]: 'text_file',
  [SourceType.PASTED_TEXT]: 'text',
  [SourceType.WEB_PAGE]: 'url',
  [SourceType.YOUTUBE]: 'youtube',
  [SourceType.MARKDOWN]: 'text_file',
  [SourceType.DOCX]: 'text_file',
  [SourceType.CSV]: 'text',
  [SourceType.IMAGE]: 'text',
  [SourceType.MEDIA]: 'text',
  [SourceType.GOOGLE_DRIVE_AUDIO]: 'text',
  [SourceType.GOOGLE_DRIVE_VIDEO]: 'text',
  [SourceType.UNKNOWN]: 'text',
};

function toDateFromSeconds(value: unknown): Date | null {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return null;
  }

  try {
    return new Date(value * 1000);
  } catch {
    return null;
  }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function safeSourceType(typeCode: number | null | undefined): SourceType {
  if (typeCode === null || typeCode === undefined) {
    return SourceType.UNKNOWN;
  }

  const mapped = SOURCE_TYPE_CODE_MAP[typeCode];
  if (mapped) {
    return mapped;
  }

  if (!warnedSourceTypes.has(typeCode)) {
    warnedSourceTypes.add(typeCode);
    console.warn(
      new UnknownTypeWarning(
        `Unknown source type code ${typeCode}. Consider updating notebooklm to the latest version.`,
      ),
    );
  }

  return SourceType.UNKNOWN;
}

export function mapArtifactKind(artifactType: number, variant: number | null): ArtifactType {
  if (artifactType === 4) {
    if (variant === 1) {
      return ArtifactType.FLASHCARDS;
    }

    if (variant === 2) {
      return ArtifactType.QUIZ;
    }

    const key = `${artifactType}:${String(variant)}`;
    if (!warnedArtifactTypes.has(key)) {
      warnedArtifactTypes.add(key);
      console.warn(
        new UnknownTypeWarning(
          `Unknown QUIZ variant ${String(variant)}. Consider updating notebooklm to the latest version.`,
        ),
      );
    }

    return ArtifactType.UNKNOWN;
  }

  const mapped = ARTIFACT_TYPE_CODE_MAP[artifactType];
  if (mapped) {
    return mapped;
  }

  const key = `${artifactType}:${String(variant)}`;
  if (!warnedArtifactTypes.has(key)) {
    warnedArtifactTypes.add(key);
    console.warn(
      new UnknownTypeWarning(
        `Unknown artifact type ${artifactType}. Consider updating notebooklm to the latest version.`,
      ),
    );
  }

  return ArtifactType.UNKNOWN;
}

export enum ChatMode {
  DEFAULT = 'default',
  LEARNING_GUIDE = 'learning_guide',
  CONCISE = 'concise',
  DETAILED = 'detailed',
}

export interface Notebook {
  id: string;
  title: string;
  createdAt: Date | null;
  sourcesCount: number;
  isOwner: boolean;
}

export const Notebook = {
  fromApiResponse(data: unknown[]): Notebook {
    const rawTitle = asString(data[0]) ?? '';
    const title = rawTitle.replace('thought\n', '').trim();
    const notebookId = asString(data[2]) ?? '';

    let createdAt: Date | null = null;
    const meta = asArray(data[5]);
    const tsData = asArray(meta[5]);
    if (tsData.length > 0) {
      createdAt = toDateFromSeconds(tsData[0]);
    }

    let isOwner = true;
    if (meta.length > 1) {
      isOwner = meta[1] === false;
    }

    return {
      id: notebookId,
      title,
      createdAt,
      sourcesCount: 0,
      isOwner,
    };
  },
};

export interface SuggestedTopic {
  question: string;
  prompt: string;
}

export interface NotebookDescription {
  summary: string;
  suggestedTopics: SuggestedTopic[];
}

export const NotebookDescription = {
  fromApiResponse(data: Record<string, unknown>): NotebookDescription {
    const topicsRaw = asArray(data.suggested_topics);
    const suggestedTopics = topicsRaw.map((item) => {
      const topic = (item ?? {}) as Record<string, unknown>;
      return {
        question: asString(topic.question) ?? '',
        prompt: asString(topic.prompt) ?? '',
      };
    });

    return {
      summary: asString(data.summary) ?? '',
      suggestedTopics,
    };
  },
};

export interface Source {
  id: string;
  title: string | null;
  url: string | null;
  typeCode: number | null;
  createdAt: Date | null;
  status: SourceStatus;
  kind: SourceType;
  sourceType: string;
  isReady: boolean;
  isProcessing: boolean;
  isError: boolean;
}

function buildSource(params: {
  id: string;
  title?: string | null;
  url?: string | null;
  typeCode?: number | null;
  createdAt?: Date | null;
  status?: SourceStatus;
}): Source {
  const typeCode = params.typeCode ?? null;
  const status = params.status ?? SourceStatus.READY;
  const kind = safeSourceType(typeCode);

  return {
    id: params.id,
    title: params.title ?? null,
    url: params.url ?? null,
    typeCode,
    createdAt: params.createdAt ?? null,
    status,
    kind,
    sourceType: SOURCE_TYPE_COMPAT_MAP[kind] ?? 'text',
    isReady: status === SourceStatus.READY,
    isProcessing: status === SourceStatus.PROCESSING,
    isError: status === SourceStatus.ERROR,
  };
}

export const Source = {
  fromApiResponse(data: unknown[], _notebookId?: string | null): Source {
    if (!Array.isArray(data) || data.length === 0) {
      throw new Error(`Invalid source data: ${JSON.stringify(data)}`);
    }

    if (Array.isArray(data[0]) && data[0].length > 0) {
      const first = data[0] as unknown[];

      if (Array.isArray(first[0]) && first[0].length > 0) {
        if (Array.isArray((first[0] as unknown[])[0])) {
          const entry = first[0] as unknown[];
          const sourceIdRaw = Array.isArray(entry[0]) ? (entry[0] as unknown[])[0] : entry[0];
          const sourceId = asString(sourceIdRaw) ?? String(sourceIdRaw ?? '');
          const title = asString(entry[1]);

          let url: string | null = null;
          let typeCode: number | null = null;
          const metadata = asArray(entry[2]);
          if (metadata.length > 7 && Array.isArray(metadata[7])) {
            url = asString((metadata[7] as unknown[])[0]);
          }
          if (!url && metadata.length > 0 && asString(metadata[0])?.startsWith('http')) {
            url = asString(metadata[0]);
          }
          if (metadata.length > 4) {
            typeCode = asNumber(metadata[4]);
          }

          return buildSource({ id: sourceId, title, url, typeCode, status: SourceStatus.READY });
        }

        const entry = first;
        const sourceIdRaw = Array.isArray(entry[0]) ? (entry[0] as unknown[])[0] : entry[0];
        const sourceId = asString(sourceIdRaw) ?? String(sourceIdRaw ?? '');
        const title = asString(entry[1]);

        let url: string | null = null;
        const metadata = asArray(entry[2]);
        if (metadata.length > 7 && Array.isArray(metadata[7])) {
          url = asString((metadata[7] as unknown[])[0]);
        }

        return buildSource({
          id: sourceId,
          title,
          url,
          typeCode: null,
          status: SourceStatus.READY,
        });
      }
    }

    const sourceId = asString(data[0]) ?? String(data[0] ?? '');
    const title = asString(data[1]);
    return buildSource({ id: sourceId, title, status: SourceStatus.READY });
  },
};

export interface SourceFulltext {
  sourceId: string;
  title: string;
  content: string;
  typeCode: number | null;
  kind: SourceType;
  sourceType: string;
  url: string | null;
  charCount: number;
}

export function findCitationContext(
  fulltext: SourceFulltext,
  citedText: string,
  contextChars = 200,
): Array<[string, number]> {
  if (!citedText || !fulltext.content) {
    return [];
  }

  const searchText = citedText.slice(0, Math.min(40, citedText.length));
  const matches: Array<[string, number]> = [];

  let pos = 0;
  while (true) {
    const idx = fulltext.content.indexOf(searchText, pos);
    if (idx === -1) {
      break;
    }

    const start = Math.max(0, idx - contextChars);
    const end = Math.min(fulltext.content.length, idx + searchText.length + contextChars);
    matches.push([fulltext.content.slice(start, end), idx]);
    pos = idx + searchText.length;
  }

  return matches;
}

export interface Artifact {
  id: string;
  title: string;
  artifactType: number;
  status: number;
  createdAt: Date | null;
  url: string | null;
  variant: number | null;
  kind: ArtifactType;
  isCompleted: boolean;
  isProcessing: boolean;
  isPending: boolean;
  isFailed: boolean;
  statusStr: string;
  isQuiz: boolean;
  isFlashcards: boolean;
  reportSubtype: string | null;
}

function buildArtifact(params: {
  id: string;
  title: string;
  artifactType: number;
  status: number;
  createdAt?: Date | null;
  url?: string | null;
  variant?: number | null;
}): Artifact {
  const variant = params.variant ?? null;
  const kind = mapArtifactKind(params.artifactType, variant);
  const titleLower = params.title.toLowerCase();

  let reportSubtype: string | null = null;
  if (params.artifactType === 2) {
    if (titleLower.startsWith('briefing doc')) {
      reportSubtype = 'briefing_doc';
    } else if (titleLower.startsWith('study guide')) {
      reportSubtype = 'study_guide';
    } else if (titleLower.startsWith('blog post')) {
      reportSubtype = 'blog_post';
    } else {
      reportSubtype = 'report';
    }
  }

  return {
    id: params.id,
    title: params.title,
    artifactType: params.artifactType,
    status: params.status,
    createdAt: params.createdAt ?? null,
    url: params.url ?? null,
    variant,
    kind,
    isCompleted: params.status === ArtifactStatus.COMPLETED,
    isProcessing: params.status === ArtifactStatus.PROCESSING,
    isPending: params.status === ArtifactStatus.PENDING,
    isFailed: params.status === ArtifactStatus.FAILED,
    statusStr: artifactStatusToStr(params.status),
    isQuiz: params.artifactType === 4 && variant === 2,
    isFlashcards: params.artifactType === 4 && variant === 1,
    reportSubtype,
  };
}

export const Artifact = {
  fromApiResponse(data: unknown[]): Artifact {
    const artifactId = asString(data[0]) ?? String(data[0] ?? '');
    const title = asString(data[1]) ?? '';
    const artifactType = asNumber(data[2]) ?? 0;
    const status = asNumber(data[4]) ?? 0;

    let createdAt: Date | null = null;
    const tsData = asArray(data[15]);
    if (tsData.length > 0) {
      createdAt = toDateFromSeconds(tsData[0]);
    }

    let variant: number | null = null;
    const optionsWrap = asArray(data[9]);
    const options = asArray(optionsWrap[1]);
    if (options.length > 0) {
      variant = asNumber(options[0]);
    }

    return buildArtifact({
      id: artifactId,
      title,
      artifactType,
      status,
      createdAt,
      variant,
      url: null,
    });
  },

  fromMindMap(data: unknown[]): Artifact | null {
    if (!Array.isArray(data) || data.length < 1) {
      return null;
    }

    const mindMapId = asString(data[0]) ?? String(data[0] ?? '');

    if (data.length >= 3 && data[1] === null && data[2] === 2) {
      return null;
    }

    let title = '';
    let createdAt: Date | null = null;

    const inner = asArray(data[1]);
    if (inner.length > 4) {
      title = asString(inner[4]) ?? '';
    }

    const metadata = asArray(inner[2]);
    const tsData = asArray(metadata[2]);
    if (tsData.length > 0) {
      createdAt = toDateFromSeconds(tsData[0]);
    }

    return buildArtifact({
      id: mindMapId,
      title,
      artifactType: 5,
      status: 3,
      createdAt,
      variant: null,
      url: null,
    });
  },
};

export interface GenerationStatus {
  taskId: string;
  status: string;
  url: string | null;
  error: string | null;
  errorCode: string | null;
  metadata: Record<string, unknown> | null;
  isComplete: boolean;
  isFailed: boolean;
  isPending: boolean;
  isInProgress: boolean;
  isRateLimited: boolean;
}

export function createGenerationStatus(params: {
  taskId: string;
  status: string;
  url?: string | null;
  error?: string | null;
  errorCode?: string | null;
  metadata?: Record<string, unknown> | null;
}): GenerationStatus {
  const status = params.status;
  const error = params.error ?? null;
  const errorCode = params.errorCode ?? null;

  const isFailed = status === 'failed';
  const isRateLimited =
    isFailed &&
    (errorCode === 'USER_DISPLAYABLE_ERROR' ||
      (typeof error === 'string' &&
        (error.toLowerCase().includes('rate limit') || error.toLowerCase().includes('quota'))));

  return {
    taskId: params.taskId,
    status,
    url: params.url ?? null,
    error,
    errorCode,
    metadata: params.metadata ?? null,
    isComplete: status === 'completed',
    isFailed,
    isPending: status === 'pending',
    isInProgress: status === 'in_progress',
    isRateLimited,
  };
}

export interface ReportSuggestion {
  title: string;
  description: string;
  prompt: string;
  audienceLevel: number;
}

export const ReportSuggestion = {
  fromApiResponse(data: Record<string, unknown>): ReportSuggestion {
    return {
      title: asString(data.title) ?? '',
      description: asString(data.description) ?? '',
      prompt: asString(data.prompt) ?? '',
      audienceLevel: asNumber(data.audience_level) ?? 2,
    };
  },
};

export interface Note {
  id: string;
  notebookId: string;
  title: string;
  content: string;
  createdAt: Date | null;
}

export const Note = {
  fromApiResponse(data: unknown[], notebookId: string): Note {
    const noteId = asString(data[0]) ?? String(data[0] ?? '');
    const title = asString(data[1]) ?? '';
    const content = asString(data[2]) ?? '';

    let createdAt: Date | null = null;
    const tsData = asArray(data[3]);
    if (tsData.length > 0) {
      createdAt = toDateFromSeconds(tsData[0]);
    }

    return {
      id: noteId,
      notebookId,
      title,
      content,
      createdAt,
    };
  },
};

export interface ConversationTurn {
  query: string;
  answer: string;
  turnNumber: number;
}

export interface ChatReference {
  sourceId: string;
  citationNumber: number | null;
  citedText: string | null;
  startChar: number | null;
  endChar: number | null;
  chunkId: string | null;
}

export interface AskResult {
  answer: string;
  conversationId: string;
  turnNumber: number;
  isFollowUp: boolean;
  references: ChatReference[];
  rawResponse: string;
}

export interface SharedUser {
  email: string;
  permission: SharePermission;
  displayName: string | null;
  avatarUrl: string | null;
}

export const SharedUser = {
  fromApiResponse(data: unknown[]): SharedUser {
    const email = asString(data[0]) ?? '';
    const permValue = asNumber(data[1]) ?? SharePermission.VIEWER;

    let permission = SharePermission.VIEWER;
    if (Object.values(SharePermission).includes(permValue as SharePermission)) {
      permission = permValue as SharePermission;
    }

    const userInfo = asArray(data[3]);
    const displayName = asString(userInfo[0]);
    const avatarUrl = asString(userInfo[1]);

    return {
      email,
      permission,
      displayName,
      avatarUrl,
    };
  },
};

export interface ShareStatus {
  notebookId: string;
  isPublic: boolean;
  access: ShareAccess;
  viewLevel: ShareViewLevel;
  sharedUsers: SharedUser[];
  shareUrl: string | null;
}

export const ShareStatus = {
  fromApiResponse(data: unknown[], notebookId: string): ShareStatus {
    const usersRaw = asArray(data[0]);
    const sharedUsers = usersRaw
      .filter((entry): entry is unknown[] => Array.isArray(entry))
      .map((entry) => SharedUser.fromApiResponse(entry));

    let isPublic = false;
    const publicData = asArray(data[1]);
    if (publicData.length > 0) {
      isPublic = Boolean(publicData[0]);
    }

    const access = isPublic ? ShareAccess.ANYONE_WITH_LINK : ShareAccess.RESTRICTED;
    const viewLevel = ShareViewLevel.FULL_NOTEBOOK;
    const shareUrl = isPublic ? `https://notebooklm.google.com/notebook/${notebookId}` : null;

    return {
      notebookId,
      isPublic,
      access,
      viewLevel,
      sharedUsers,
      shareUrl,
    };
  },
};

export function createSourceFulltext(params: {
  sourceId: string;
  title: string;
  content: string;
  typeCode?: number | null;
  url?: string | null;
}): SourceFulltext {
  const typeCode = params.typeCode ?? null;
  const kind = safeSourceType(typeCode);

  return {
    sourceId: params.sourceId,
    title: params.title,
    content: params.content,
    typeCode,
    kind,
    sourceType: SOURCE_TYPE_COMPAT_MAP[kind] ?? 'text',
    url: params.url ?? null,
    charCount: params.content.length,
  };
}

export function createSource(params: {
  id: string;
  title?: string | null;
  url?: string | null;
  typeCode?: number | null;
  createdAt?: Date | null;
  status?: SourceStatus;
}): Source {
  return buildSource(params);
}

export function createArtifact(params: {
  id: string;
  title: string;
  artifactType: number;
  status: number;
  createdAt?: Date | null;
  url?: string | null;
  variant?: number | null;
}): Artifact {
  return buildArtifact(params);
}
