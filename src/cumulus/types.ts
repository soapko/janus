export interface Message {
  /** Unique identifier — nanoid from cumulus HistoryStore */
  id: string;
  role: 'user' | 'assistant' | 'session';
  content: string;
  /** Unix timestamp in milliseconds */
  timestamp: number;
  tokenCount?: number;
  metadata?: Record<string, unknown>;
}

export interface CumulusChatAPI {
  sendMessage: (message: string) => void;
  kill: () => void;
  getHistory: (count: number) => Promise<Message[]>;
  listThreads: () => Promise<string[]>;
  threadName: string;
  onMessage: (callback: (data: { threadName: string; message: Message }) => void) => void;
  onStreamChunk: (callback: (data: { threadName: string; text: string }) => void) => void;
  onStreamEnd: (callback: (data: { threadName: string; message: Message | null; fallbackText?: string | null }) => void) => void;
  onError: (callback: (data: { threadName: string; error: string }) => void) => void;
}
