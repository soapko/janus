import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Attachment } from './types';

interface ChatInputProps {
  onSend: (text: string, attachments: Attachment[]) => void;
  onKill: () => void;
  onSaveClipboardImage: () => Promise<Attachment | null>;
  onPickFiles: () => Promise<Attachment[]>;
  disabled: boolean;
  isStreaming: boolean;
}

export default function ChatInput({
  onSend,
  onKill,
  onSaveClipboardImage,
  onPickFiles,
  disabled,
  isStreaming,
}: ChatInputProps): React.ReactElement {
  const [value, setValue] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const hasText = value.trim().length > 0;
  const hasAttachments = attachments.length > 0;
  const hasContent = hasText || hasAttachments;

  // Context-aware button state:
  //   streaming + no content → Stop
  //   streaming + content    → Send (interject: kill stream, then send)
  //   idle + content         → Send
  //   idle + no content      → Send (disabled)
  const isStopMode = isStreaming && !hasContent;

  // Auto-resize textarea to fit content, up to CSS max-height.
  const resize = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    const maxHeight = parseFloat(getComputedStyle(textarea).maxHeight) || 9999;
    const scrollHeight = textarea.scrollHeight;
    textarea.style.height = `${Math.min(scrollHeight, maxHeight)}px`;
    textarea.style.overflowY = scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, []);

  useEffect(() => {
    resize();
  }, [value, resize]);

  const removeAttachment = useCallback((id: string) => {
    setAttachments(prev => prev.filter(a => a.id !== id));
  }, []);

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if ((!trimmed && !hasAttachments) || disabled) return;
    if (isStreaming) {
      onKill();
    }
    onSend(trimmed, attachments);
    setValue('');
    setAttachments([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.overflowY = 'hidden';
    }
  }, [value, attachments, hasAttachments, disabled, isStreaming, onKill, onSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value);
  }, []);

  // Paste handler — detect images in clipboard, otherwise handle text
  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    // Check for image items
    const items = e.clipboardData?.items;
    if (items) {
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith('image/')) {
          e.preventDefault();
          onSaveClipboardImage().then(att => {
            if (att) setAttachments(prev => [...prev, att]);
          });
          return;
        }
      }
    }
    // Text paste — merge into state manually (Electron's webContents.paste()
    // can bypass React's onChange on controlled textareas)
    e.preventDefault();
    const pasted = e.clipboardData.getData('text/plain');
    if (!pasted) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const next = value.slice(0, start) + pasted + value.slice(end);
    setValue(next);
    requestAnimationFrame(() => {
      const pos = start + pasted.length;
      textarea.selectionStart = pos;
      textarea.selectionEnd = pos;
    });
  }, [value, onSaveClipboardImage]);

  // Listen for janus-paste-image DOM event (from Electron Edit menu route).
  // The event is dispatched on the .cumulus-container ancestor, so we walk up
  // from our ref to find it and attach the listener there.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const cumulusContainer = el.closest('.cumulus-container') || el.parentElement;
    if (!cumulusContainer) return;
    const handler = () => {
      onSaveClipboardImage().then(att => {
        if (att) setAttachments(prev => [...prev, att]);
      });
    };
    cumulusContainer.addEventListener('janus-paste-image', handler);
    return () => cumulusContainer.removeEventListener('janus-paste-image', handler);
  }, [onSaveClipboardImage]);

  const handleButtonClick = useCallback(() => {
    if (isStopMode) {
      onKill();
    } else {
      handleSend();
    }
  }, [isStopMode, onKill, handleSend]);

  const handlePickFiles = useCallback(() => {
    onPickFiles().then(files => {
      if (files.length > 0) {
        setAttachments(prev => [...prev, ...files]);
      }
    });
  }, [onPickFiles]);

  const isInterjecting = isStreaming && hasContent;

  const getExtension = (name: string) => {
    const dot = name.lastIndexOf('.');
    return dot >= 0 ? name.slice(dot + 1).toUpperCase() : '?';
  };

  return (
    <div className="chat-input-area" ref={containerRef}>
      {hasAttachments && (
        <div className="attachment-strip">
          {attachments.map(att => (
            <div key={att.id} className="attachment-chip">
              {att.type === 'image' ? (
                <img
                  className="attachment-chip__thumb"
                  src={`file://${att.path}`}
                  alt={att.name}
                />
              ) : (
                <span className="attachment-chip__file-icon">
                  {getExtension(att.name)}
                </span>
              )}
              <span className="attachment-chip__name">{att.name}</span>
              <button
                className="attachment-chip__remove"
                onClick={() => removeAttachment(att.id)}
                type="button"
                aria-label={`Remove ${att.name}`}
              >
                &times;
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="chat-input-row">
        <button
          className="chat-input-attach-btn"
          onClick={handlePickFiles}
          type="button"
          title="Attach file"
          aria-label="Attach file"
        >
          +
        </button>
        {isInterjecting && (
          <span className="chat-input-interject" aria-label="Will interrupt current response" title="Will interrupt current response">!</span>
        )}
        <textarea
          ref={textareaRef}
          className="chat-input-textarea"
          value={value}
          onChange={handleChange}
          onPaste={handlePaste}
          onKeyDown={handleKeyDown}
          placeholder={isStreaming ? 'Type to interject\u2026' : 'Type a message\u2026'}
          disabled={disabled && !isStreaming}
          rows={1}
          aria-label="Message input"
        />
        <button
          className={`chat-input-btn ${isStopMode ? 'chat-input-btn--stop' : 'chat-input-btn--send'}`}
          onClick={handleButtonClick}
          type="button"
          disabled={!isStopMode && (disabled || !hasContent)}
          aria-label={isStopMode ? 'Stop response' : 'Send message'}
        >
          {isStopMode ? 'Stop' : 'Send'}
        </button>
      </div>
    </div>
  );
}
