import React, { Component, useCallback, useEffect, useRef, useState } from 'react';
import { CumulusChatAPI, Message } from './types';
import ChatInput from './ChatInput';
import MessageBubble from './MessageBubble';
import StreamingResponse from './StreamingResponse';

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

  const scrollAnchorRef = useRef<HTMLDivElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const streamBufferRef = useRef('');

  const scrollToBottom = useCallback(() => {
    // Use requestAnimationFrame to ensure the DOM has updated before scrolling
    requestAnimationFrame(() => {
      scrollAnchorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    });
  }, []);

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

    // Each on* call registers a new listener. We track unsubscribe functions
    // if the API returns them (common in Electron IPC wrappers).
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
        // Replace optimistic user message (temp id starting with '_opt_') with authoritative one
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

    const streamEndResult = api.onStreamEnd((data) => {
      if (data.threadName !== threadName) return;

      // Capture buffer BEFORE clearing — we may need it as fallback content.
      const currentBuffer = streamBufferRef.current;

      console.log('[ChatPanel] onStreamEnd received:', {
        hasMessage: !!data.message,
        messageId: data.message?.id,
        messageRole: data.message?.role,
        messageContentLength: data.message?.content?.length,
        hasFallbackText: !!data.fallbackText,
        fallbackTextLength: data.fallbackText?.length,
        currentBufferLength: currentBuffer.length,
      });

      setIsStreaming(false);
      setStreamBuffer('');
      streamBufferRef.current = '';

      // Validate message has the required properties — not just !== null.
      // Electron IPC serialization or errors could produce partial objects.
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
        setMessages((prev) => {
          const exists = prev.some((m) => m.id === msg.id);
          if (exists) {
            console.log('[ChatPanel] onStreamEnd: DUPLICATE detected, skipping');
            return prev;
          }
          console.log('[ChatPanel] onStreamEnd: appending to messages, new length =', prev.length + 1);
          return [...prev, msg];
        });
        scrollToBottom();
      } else {
        // message is missing, null, or malformed — use fallbackText or
        // the stream buffer so the user doesn't lose visible content.
        const text = data.fallbackText || currentBuffer;
        console.log('[ChatPanel] onStreamEnd: message invalid/null, fallback text length =', text?.length ?? 0);
        if (text) {
          const synthetic: Message = {
            id: `_synth_${Date.now()}`,
            role: 'assistant',
            content: text,
            timestamp: Date.now(),
          };
          setMessages((prev) => {
            console.log('[ChatPanel] onStreamEnd: appending SYNTHETIC message, new length =', prev.length + 1);
            return [...prev, synthetic];
          });
          scrollToBottom();
        } else {
          console.warn('[ChatPanel] onStreamEnd: NO content available — message will be lost');
        }
      }
    });
    tryRegisterCleanup(streamEndResult);

    const errorResult = api.onError((data) => {
      if (data.threadName !== threadName) return;
      // Do NOT clear isStreaming or streamBuffer — let stream-end handle
      // the transition.  Clearing here was causing visible text to vanish
      // when stderr emitted non-fatal warnings mid-stream.
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
    (text: string) => {
      setError(null);
      api.sendMessage(text);
      // Optimistically add the user message so the UI feels responsive.
      // The authoritative message will arrive via onMessage; deduplication
      // by id in the onMessage handler prevents doubles.
      const optimistic: Message = {
        id: `_opt_${Date.now()}`, // temporary id, replaced by authoritative message
        role: 'user',
        content: text,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, optimistic]);
      scrollToBottom();
    },
    [api, scrollToBottom],
  );

  const handleKill = useCallback(() => {
    api.kill();
  }, [api]);

  const handleLoadThreads = useCallback(() => {
    api.listThreads().then(setThreads).catch(() => {});
    setShowThreadPicker((prev) => !prev);
  }, [api]);

  const isEmpty = messages.length === 0 && !isStreaming && !isLoading;

  // Diagnostic: log every render to trace state changes
  console.log('[ChatPanel] render: messages =', messages.length, 'isStreaming =', isStreaming, 'streamBuffer =', streamBuffer.length);

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <div className="chat-header__thread-info">
          <span className="chat-header__thread-name">{api.threadName}</span>
        </div>
        <div className="chat-header__actions">
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
              >
                {t}
              </div>
            ))}
          </div>
        )}
      </div>
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

        {isStreaming && streamBuffer.length > 0 && (
          <StreamingResponse text={streamBuffer} />
        )}

        {error && (
          <div className="chat-error" role="alert">
            <span className="chat-error__label">Error:</span> {error}
          </div>
        )}

        <div ref={scrollAnchorRef} className="chat-scroll-anchor" />
      </div>

      <ChatInput
        onSend={handleSend}
        onKill={handleKill}
        disabled={isLoading}
        isStreaming={isStreaming}
      />
    </div>
  );
}
