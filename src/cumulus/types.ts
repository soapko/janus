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
}
