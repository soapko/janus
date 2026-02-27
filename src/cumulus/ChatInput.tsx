import React, { useCallback, useEffect, useRef, useState } from 'react';

interface ChatInputProps {
  onSend: (text: string) => void;
  onKill: () => void;
  disabled: boolean;
  isStreaming: boolean;
}

export default function ChatInput({
  onSend,
  onKill,
  disabled,
  isStreaming,
}: ChatInputProps): React.ReactElement {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const hasText = value.trim().length > 0;

  // Context-aware button state:
  //   streaming + no text  → Stop
  //   streaming + text     → Send (interject: kill stream, then send)
  //   idle + text          → Send
  //   idle + no text       → Send (disabled)
  const isStopMode = isStreaming && !hasText;

  // Auto-resize textarea to fit content, up to CSS max-height.
  // Reads the computed max-height from CSS so the limit stays proportional.
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

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    // If streaming, kill the current response before sending
    if (isStreaming) {
      onKill();
    }
    onSend(trimmed);
    setValue('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.overflowY = 'hidden';
    }
  }, [value, disabled, isStreaming, onKill, onSend]);

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

  // Explicit paste handler — Electron's webContents.paste() can bypass
  // React's onChange on controlled textareas, so we read the clipboard
  // and merge the pasted text into state ourselves.
  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text/plain');
    if (!pasted) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const next = value.slice(0, start) + pasted + value.slice(end);
    setValue(next);
    // Restore cursor position after React re-renders
    requestAnimationFrame(() => {
      const pos = start + pasted.length;
      textarea.selectionStart = pos;
      textarea.selectionEnd = pos;
    });
  }, [value]);

  const handleButtonClick = useCallback(() => {
    if (isStopMode) {
      onKill();
    } else {
      handleSend();
    }
  }, [isStopMode, onKill, handleSend]);

  const isInterjecting = isStreaming && hasText;

  return (
    <div className="chat-input-area">
      <div className="chat-input-row">
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
          disabled={!isStopMode && (disabled || !hasText)}
          aria-label={isStopMode ? 'Stop response' : 'Send message'}
        >
          {isStopMode ? 'Stop' : 'Send'}
        </button>
      </div>
    </div>
  );
}
