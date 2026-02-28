export interface Message {
  /** Unique identifier — nanoid from cumulus HistoryStore */
  id: string;
  role: 'user' | 'assistant' | 'session';
  content: string;
  /** Unix timestamp in milliseconds */
  timestamp: number;
  tokenCount?: number;
  metadata?: Record<string, unknown>;
  attachments?: Attachment[];
}

export interface Attachment {
  id: string;
  name: string;
  path: string;
  type: 'image' | 'file';
  mimeType: string;
}

export interface IncludeFileInfo {
  path: string;
  scope: 'global' | 'thread';
}

export interface TurnInfo {
  id: string;
  userMessage: string;
  assistantMessage?: string;
  timestamp: number;
  hasSnapshot: boolean;
}

export interface RevertResult {
  success: boolean;
  removedCount: number;
  error?: string;
}

export interface CumulusChatAPI {
  sendMessage: (message: string, attachments?: Attachment[]) => void;
  kill: () => void;
  getHistory: (count: number) => Promise<Message[]>;
  listThreads: () => Promise<string[]>;
  threadName: string;
  saveClipboardImage: () => Promise<Attachment | null>;
  pickFiles: () => Promise<Attachment[]>;
  onMessage: (callback: (data: { threadName: string; message: Message }) => void) => void;
  onStreamChunk: (callback: (data: { threadName: string; text: string }) => void) => void;
  onStreamEnd: (callback: (data: { threadName: string; message: Message | null; fallbackText?: string | null }) => void) => void;
  onError: (callback: (data: { threadName: string; error: string }) => void) => void;
  // Slash command APIs
  listIncludeFiles: () => Promise<IncludeFileInfo[]>;
  addIncludeFile: (filePath: string, scope: 'global' | 'thread') => Promise<void>;
  removeIncludeFile: (filePath: string, scope: 'global' | 'thread') => Promise<void>;
  getTurns: () => Promise<TurnInfo[]>;
  revert: (messageId: string, restoreGit: boolean) => Promise<RevertResult>;
  closeTab: () => void;
}
