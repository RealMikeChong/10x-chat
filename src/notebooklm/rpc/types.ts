/** RPC types and constants for NotebookLM API. */

export const BATCHEXECUTE_URL = 'https://notebooklm.google.com/_/LabsTailwindUi/data/batchexecute';
export const QUERY_URL =
  'https://notebooklm.google.com/_/LabsTailwindUi/data/google.internal.labs.tailwind.orchestration.v1.LabsTailwindOrchestrationService/GenerateFreeFormStreamed';
export const UPLOAD_URL = 'https://notebooklm.google.com/upload/_/';

export enum RPCMethod {
  LIST_NOTEBOOKS = 'wXbhsf',
  CREATE_NOTEBOOK = 'CCqFvf',
  GET_NOTEBOOK = 'rLM1Ne',
  RENAME_NOTEBOOK = 's0tc2d',
  DELETE_NOTEBOOK = 'WWINqb',

  ADD_SOURCE = 'izAoDd',
  ADD_SOURCE_FILE = 'o4cbdc',
  DELETE_SOURCE = 'tGMBJ',
  GET_SOURCE = 'hizoJc',
  REFRESH_SOURCE = 'FLmJqe',
  CHECK_SOURCE_FRESHNESS = 'yR9Yof',
  UPDATE_SOURCE = 'b7Wfje',
  DISCOVER_SOURCES = 'qXyaNe',

  SUMMARIZE = 'VfAZjd',
  GET_SOURCE_GUIDE = 'tr032e',
  GET_SUGGESTED_REPORTS = 'ciyUvf',

  QUERY_ENDPOINT = '/_/LabsTailwindUi/data/google.internal.labs.tailwind.orchestration.v1.LabsTailwindOrchestrationService/GenerateFreeFormStreamed',

  CREATE_ARTIFACT = 'R7cb6c',
  LIST_ARTIFACTS = 'gArtLc',
  DELETE_ARTIFACT = 'V5N4be',
  RENAME_ARTIFACT = 'rc3d8d',
  EXPORT_ARTIFACT = 'Krh3pd',
  SHARE_ARTIFACT = 'RGP97b',
  GET_INTERACTIVE_HTML = 'v9rmvd',

  START_FAST_RESEARCH = 'Ljjv0c',
  START_DEEP_RESEARCH = 'QA9ei',
  POLL_RESEARCH = 'e3bVqc',
  IMPORT_RESEARCH = 'LBwxtb',

  GENERATE_MIND_MAP = 'yyryJe',
  CREATE_NOTE = 'CYK0Xb',
  GET_NOTES_AND_MIND_MAPS = 'cFji9',
  UPDATE_NOTE = 'cYAfTb',
  DELETE_NOTE = 'AH0mwd',

  GET_CONVERSATION_HISTORY = 'hPTbtc',

  SHARE_NOTEBOOK = 'QDyure',
  GET_SHARE_STATUS = 'JFMDGd',

  REMOVE_RECENTLY_VIEWED = 'fejl7e',

  GET_USER_SETTINGS = 'ZwVcOc',
  SET_USER_SETTINGS = 'hT54vc',
}

export enum ArtifactTypeCode {
  AUDIO = 1,
  REPORT = 2,
  VIDEO = 3,
  QUIZ = 4,
  QUIZ_FLASHCARD = 4,
  MIND_MAP = 5,
  INFOGRAPHIC = 7,
  SLIDE_DECK = 8,
  DATA_TABLE = 9,
}

/** Deprecated alias for backward compatibility. */
export const StudioContentType = ArtifactTypeCode;

export enum ArtifactStatus {
  PROCESSING = 1,
  PENDING = 2,
  COMPLETED = 3,
  FAILED = 4,
}

const ARTIFACT_STATUS_MAP: Record<number, string> = {
  [ArtifactStatus.PROCESSING]: 'in_progress',
  [ArtifactStatus.PENDING]: 'pending',
  [ArtifactStatus.COMPLETED]: 'completed',
  [ArtifactStatus.FAILED]: 'failed',
};

export function artifactStatusToStr(statusCode: number): string {
  return ARTIFACT_STATUS_MAP[statusCode] ?? 'unknown';
}

export enum AudioFormat {
  DEEP_DIVE = 1,
  BRIEF = 2,
  CRITIQUE = 3,
  DEBATE = 4,
}

export enum AudioLength {
  SHORT = 1,
  DEFAULT = 2,
  LONG = 3,
}

export enum VideoFormat {
  EXPLAINER = 1,
  BRIEF = 2,
}

export enum VideoStyle {
  AUTO_SELECT = 1,
  CUSTOM = 2,
  CLASSIC = 3,
  WHITEBOARD = 4,
  KAWAII = 5,
  ANIME = 6,
  WATERCOLOR = 7,
  RETRO_PRINT = 8,
  HERITAGE = 9,
  PAPER_CRAFT = 10,
}

export enum QuizQuantity {
  FEWER = 1,
  STANDARD = 2,
  MORE = 2,
}

export enum QuizDifficulty {
  EASY = 1,
  MEDIUM = 2,
  HARD = 3,
}

export enum InfographicOrientation {
  LANDSCAPE = 1,
  PORTRAIT = 2,
  SQUARE = 3,
}

export enum InfographicDetail {
  CONCISE = 1,
  STANDARD = 2,
  DETAILED = 3,
}

export enum SlideDeckFormat {
  DETAILED_DECK = 1,
  PRESENTER_SLIDES = 2,
}

export enum SlideDeckLength {
  DEFAULT = 1,
  SHORT = 2,
}

export enum ReportFormat {
  BRIEFING_DOC = 'briefing_doc',
  STUDY_GUIDE = 'study_guide',
  BLOG_POST = 'blog_post',
  CUSTOM = 'custom',
}

export enum ChatGoal {
  DEFAULT = 1,
  CUSTOM = 2,
  LEARNING_GUIDE = 3,
}

export enum ChatResponseLength {
  DEFAULT = 1,
  LONGER = 4,
  SHORTER = 5,
}

export enum DriveMimeType {
  GOOGLE_DOC = 'application/vnd.google-apps.document',
  GOOGLE_SLIDES = 'application/vnd.google-apps.presentation',
  GOOGLE_SHEETS = 'application/vnd.google-apps.spreadsheet',
  PDF = 'application/pdf',
}

export enum ExportType {
  DOCS = 1,
  SHEETS = 2,
}

export enum ShareAccess {
  RESTRICTED = 0,
  ANYONE_WITH_LINK = 1,
}

export enum ShareViewLevel {
  FULL_NOTEBOOK = 0,
  CHAT_ONLY = 1,
}

export enum SharePermission {
  OWNER = 1,
  EDITOR = 2,
  VIEWER = 3,
  _REMOVE = 4,
}

export enum SourceStatus {
  PROCESSING = 1,
  READY = 2,
  ERROR = 3,
  PREPARING = 5,
}

const SOURCE_STATUS_MAP: Record<number, string> = {
  [SourceStatus.PROCESSING]: 'processing',
  [SourceStatus.READY]: 'ready',
  [SourceStatus.ERROR]: 'error',
  [SourceStatus.PREPARING]: 'preparing',
};

export function sourceStatusToStr(statusCode: number | SourceStatus): string {
  return SOURCE_STATUS_MAP[Number(statusCode)] ?? 'unknown';
}
