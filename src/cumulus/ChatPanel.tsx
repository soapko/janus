import React, { Component, useCallback, useEffect, useRef, useState } from 'react';
import { Attachment, CumulusChatAPI, Message, StreamSegment } from './types';
import ChatInput from './ChatInput';
import MessageBubble from './MessageBubble';
import StreamingResponse from './StreamingResponse';
import IncludeOverlay from './IncludeOverlay';
import RevertOverlay from './RevertOverlay';

// Error boundary to prevent a single message render crash from wiping the whole panel
class MessageErrorBoundary extends Component<
  { children: React.ReactNode; fallbackText?: string },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    console.error('[MessageErrorBoundary] render crash:', error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="message-bubble message-bubble--assistant">
          <div className="message-bubble__content">
            <pre style={{ whiteSpace: 'pre-wrap', opacity: 0.7 }}>
              {this.props.fallbackText || '[Render error]'}
            </pre>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

type OverlayMode = 'include' | 'revert' | null;

interface ChatPanelProps {
  api: CumulusChatAPI;
}

export default function ChatPanel({ api }: ChatPanelProps): React.ReactElement {
  const [messages, setMessages] = useState<Message[]>([]);
  const [streamBuffer, setStreamBuffer] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [threads, setThreads] = useState<string[]>([]);
  const [showThreadPicker, setShowThreadPicker] = useState(false);
  const [overlay, setOverlay] = useState<OverlayMode>(null);
  const [streamSegments, setStreamSegments] = useState<StreamSegment[]>([]);
  const [showVerbose, setShowVerbose] = useState<boolean>(() => {
    try { return localStorage.getItem('cumulus:showVerbose') === 'true'; } catch { return false; }
  });

  const scrollAnchorRef = useRef<HTMLDivElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const streamBufferRef = useRef('');
  const streamSegmentsRef = useRef<StreamSegment[]>([]);
  const streamCapturedRef = useRef(false);

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      scrollAnchorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    });
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const history = await api.getHistory(50);
      const filtered = history.filter((m) => m.role !== 'session');
      setMessages(filtered);
      scrollToBottom();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(`Failed to load history: ${message}`);
    }
  }, [api, scrollToBottom]);

  // Load history on mount
  useEffect(() => {
    let cancelled = false;

    api
      .getHistory(50)
      .then((history) => {
        if (cancelled) return;
        const filtered = history.filter((m) => m.role !== 'session');
        setMessages(filtered);
        setIsLoading(false);
        scrollToBottom();
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(`Failed to load history: ${message}`);
        setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [api, scrollToBottom]);

  // Subscribe to IPC events
  useEffect(() => {
    const { threadName } = api;

    const unsubscribeFns: Array<() => void> = [];

    const tryRegisterCleanup = (result: unknown) => {
      if (typeof result === 'function') {
        unsubscribeFns.push(result as () => void);
      }
    };

    const messageResult = api.onMessage((data) => {
      if (data.threadName !== threadName) return;
      if (data.message.role === 'session') return;
      console.log('[ChatPanel] onMessage:', data.message.role, 'id =', data.message.id);
      setMessages((prev) => {
        const exists = prev.some((m) => m.id === data.message.id);
        if (exists) return prev;
        if (data.message.role === 'user') {
          const optimisticIdx = prev.findIndex((m) => m.id.startsWith('_opt_') && m.role === 'user');
          if (optimisticIdx !== -1) {
            const next = [...prev];
            next[optimisticIdx] = data.message;
            return next;
          }
        }
        return [...prev, data.message];
      });
      scrollToBottom();
    });
    tryRegisterCleanup(messageResult);

    const chunkResult = api.onStreamChunk((data) => {
      if (data.threadName !== threadName) return;
      setIsStreaming(true);
      setError(null);
      setStreamBuffer((prev) => {
        const next = prev + data.text;
        streamBufferRef.current = next;
        return next;
      });
      scrollToBottom();
    });
    tryRegisterCleanup(chunkResult);

    const segmentResult = api.onStreamSegment((data) => {
      if (data.threadName !== threadName) return;
      setStreamSegments((prev) => {
        const next = [...prev, data.segment];
        streamSegmentsRef.current = next;
        return next;
      });
      scrollToBottom();
    });
    tryRegisterCleanup(segmentResult);

    const streamEndResult = api.onStreamEnd((data) => {
      if (data.threadName !== threadName) return;

      // If the stream was already captured by an interjection, suppress the
      // duplicate — the partial text was frozen inline before the user message
      if (streamCapturedRef.current) {
        streamCapturedRef.current = false;
        setIsStreaming(false);
        setStreamBuffer('');
        streamBufferRef.current = '';
        setStreamSegments([]);
        streamSegmentsRef.current = [];
        return;
      }

      const currentBuffer = streamBufferRef.current;
      const currentSegments = data.segments || streamSegmentsRef.current;

      console.log('[ChatPanel] onStreamEnd received:', {
        hasMessage: !!data.message,
        messageId: data.message?.id,
        messageRole: data.message?.role,
        messageContentLength: data.message?.content?.length,
        hasFallbackText: !!data.fallbackText,
        fallbackTextLength: data.fallbackText?.length,
        currentBufferLength: currentBuffer.length,
        segmentCount: currentSegments.length,
      });

      setIsStreaming(false);
      setStreamBuffer('');
      streamBufferRef.current = '';
      setStreamSegments([]);
      streamSegmentsRef.current = [];

      const msg = data.message;
      const isValidMessage =
        msg != null &&
        typeof msg.content === 'string' &&
        msg.content.length > 0 &&
        typeof msg.id === 'string' &&
        msg.id.length > 0 &&
        msg.role !== 'session';

      if (isValidMessage) {
        console.log('[ChatPanel] onStreamEnd: adding valid message, id =', msg.id);
        const messageWithSegments = currentSegments.length > 0
          ? { ...msg, segments: currentSegments }
          : msg;
        setMessages((prev) => {
          const exists = prev.some((m) => m.id === msg.id);
          if (exists) return prev;
          return [...prev, messageWithSegments];
        });
        scrollToBottom();
      } else {
        const text = data.fallbackText || currentBuffer;
        console.log('[ChatPanel] onStreamEnd: message invalid/null, fallback text length =', text?.length ?? 0);
        if (text) {
          const synthetic: Message = {
            id: `_synth_${Date.now()}`,
            role: 'assistant',
            content: text,
            timestamp: Date.now(),
            segments: currentSegments.length > 0 ? currentSegments : undefined,
          };
          setMessages((prev) => [...prev, synthetic]);
          scrollToBottom();
        }
      }
    });
    tryRegisterCleanup(streamEndResult);

    const errorResult = api.onError((data) => {
      if (data.threadName !== threadName) return;
      setError(data.error);
      scrollToBottom();
    });
    tryRegisterCleanup(errorResult);

    return () => {
      for (const unsub of unsubscribeFns) {
        try {
          unsub();
        } catch {
          // Ignore cleanup errors
        }
      }
    };
  }, [api, scrollToBottom]);

  const handleSend = useCallback(
    (text: string, attachments: Attachment[]) => {
      setError(null);

      // If interjecting during streaming, freeze the partial response first
      // so it appears ABOVE the user's interjection in the message list
      if (isStreaming) {
        const partialText = streamBufferRef.current;
        const partialSegments = [...streamSegmentsRef.current];

        // Clear streaming state immediately
        setIsStreaming(false);
        setStreamBuffer('');
        streamBufferRef.current = '';
        setStreamSegments([]);
        streamSegmentsRef.current = [];
        streamCapturedRef.current = true;

        // Add partial assistant message if there was any streamed text
        if (partialText) {
          const partial: Message = {
            id: `_partial_${Date.now()}`,
            role: 'assistant',
            content: partialText,
            timestamp: Date.now(),
            segments: partialSegments.length > 0 ? partialSegments : undefined,
          };
          setMessages((prev) => [...prev, partial]);
        }
      }

      api.sendMessage(text, attachments);
      const optimistic: Message = {
        id: `_opt_${Date.now()}`,
        role: 'user',
        content: text,
        timestamp: Date.now(),
        attachments: attachments.length > 0 ? attachments : undefined,
      };
      setMessages((prev) => [...prev, optimistic]);
      scrollToBottom();
    },
    [api, isStreaming, scrollToBottom],
  );

  const handleKill = useCallback(() => {
    api.kill();
  }, [api]);

  const handleSlashCommand = useCallback((command: string) => {
    switch (command) {
      case '/include':
        setOverlay('include');
        break;
      case '/revert':
        setOverlay('revert');
        break;
      case '/exit':
        api.closeTab();
        break;
    }
  }, [api]);

  const handleCloseOverlay = useCallback(() => {
    setOverlay(null);
  }, []);

  const handleReverted = useCallback(() => {
    setOverlay(null);
    // Reload history from store after revert
    loadHistory();
  }, [loadHistory]);

  const handleToggleVerbose = useCallback(() => {
    setShowVerbose((prev) => {
      const next = !prev;
      try { localStorage.setItem('cumulus:showVerbose', String(next)); } catch {}
      return next;
    });
  }, []);

  const handleLoadThreads = useCallback(() => {
    api.listThreads().then(setThreads).catch(() => {});
    setShowThreadPicker((prev) => !prev);
  }, [api]);

  const isEmpty = messages.length === 0 && !isStreaming && !isLoading;

  return (
    <div className={`chat-panel${showVerbose ? ' chat-panel--verbose' : ''}`}>
      <div className="chat-header">
        <div className="chat-header__thread-info">
          <span className="chat-header__thread-name">{api.threadName}</span>
        </div>
        <div className="chat-header__actions">
          <button
            className={`chat-header__btn${showVerbose ? ' chat-header__btn--active' : ''}`}
            onClick={handleToggleVerbose}
            type="button"
            title={showVerbose ? 'Hide details' : 'Show details'}
          >
            {showVerbose ? 'Hide details' : 'Details'}
          </button>
          <button
            className="chat-header__btn"
            onClick={handleLoadThreads}
            type="button"
            title="Switch thread"
          >
            Threads
          </button>
        </div>
        {showThreadPicker && threads.length > 0 && (
          <div className="chat-thread-picker">
            {threads.map((t) => (
              <div
                key={t}
                className={`chat-thread-picker__item ${t === api.threadName ? 'chat-thread-picker__item--active' : ''}`}
                onClick={() => {
                  if (t === api.threadName) {
                    setShowThreadPicker(false);
                    return;
                  }
                  setShowThreadPicker(false);
                  api.switchThread(t);
                }}
                style={{ cursor: 'pointer' }}
              >
                {t}
              </div>
            ))}
          </div>
        )}
      </div>

      {overlay === 'include' ? (
        <IncludeOverlay api={api} onClose={handleCloseOverlay} />
      ) : overlay === 'revert' ? (
        <RevertOverlay api={api} onClose={handleCloseOverlay} onReverted={handleReverted} />
      ) : (
        <div className="chat-message-list" ref={messageListRef}>
          {isLoading && (
            <div className="chat-status-message chat-status-message--loading">
              Loading conversation...
            </div>
          )}

          {isEmpty && !isLoading && (
            <div className="chat-status-message chat-status-message--empty">
              No messages yet. Start the conversation.
            </div>
          )}

          {messages.map((msg) => (
            <MessageErrorBoundary key={msg.id} fallbackText={msg.content}>
              <MessageBubble message={msg} />
            </MessageErrorBoundary>
          ))}

          {isStreaming && (streamBuffer.length > 0 || streamSegments.length > 0) && (
            <StreamingResponse text={streamBuffer} segments={streamSegments} />
          )}

          {error && (
            <div className="chat-error" role="alert">
              <span className="chat-error__label">Error:</span> {error}
            </div>
          )}

          <div ref={scrollAnchorRef} className="chat-scroll-anchor" />
        </div>
      )}

      <ChatInput
        onSend={handleSend}
        onKill={handleKill}
        onSlashCommand={handleSlashCommand}
        onSaveClipboardImage={api.saveClipboardImage}
        onPickFiles={api.pickFiles}
        disabled={isLoading}
        isStreaming={isStreaming}
      />
    </div>
  );
}
