import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Attachment } from './types';

interface SlashCommand {
  name: string;
  description: string;
}

const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/include', description: 'Manage always-include files' },
  { name: '/revert', description: 'Revert to earlier turn' },
  { name: '/exit', description: 'Close this chat tab' },
];

interface ChatInputProps {
  onSend: (text: string, attachments: Attachment[]) => void;
  onKill: () => void;
  onSlashCommand: (command: string) => void;
  onSaveClipboardImage: () => Promise<Attachment | null>;
  onPickFiles: () => Promise<Attachment[]>;
  disabled: boolean;
  isStreaming: boolean;
}

export default function ChatInput({
  onSend,
  onKill,
  onSlashCommand,
  onSaveClipboardImage,
  onPickFiles,
  disabled,
  isStreaming,
}: ChatInputProps): React.ReactElement {
  const [value, setValue] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const hasText = value.trim().length > 0;
  const hasAttachments = attachments.length > 0;
  const hasContent = hasText || hasAttachments;

  const isStopMode = isStreaming && !hasContent;

  // Filter commands by what user has typed
  const filteredCommands = paletteOpen
    ? SLASH_COMMANDS.filter(cmd => cmd.name.startsWith(value.trim().toLowerCase()))
    : [];

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

  const executeSlashCommand = useCallback((command: string) => {
    setPaletteOpen(false);
    setPaletteIndex(0);
    setValue('');
    onSlashCommand(command);
  }, [onSlashCommand]);

  const handleSend = useCallback(() => {
    const trimmed = value.trim();

    // Check if it's a slash command
    if (trimmed.startsWith('/') && !hasAttachments) {
      const matched = SLASH_COMMANDS.find(cmd => cmd.name === trimmed);
      if (matched) {
        executeSlashCommand(matched.name);
        return;
      }
    }

    if ((!trimmed && !hasAttachments) || disabled) return;
    if (isStreaming) {
      onKill();
    }
    onSend(trimmed, attachments);
    setValue('');
    setAttachments([]);
    setPaletteOpen(false);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.overflowY = 'hidden';
    }
  }, [value, attachments, hasAttachments, disabled, isStreaming, onKill, onSend, executeSlashCommand]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (paletteOpen && filteredCommands.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setPaletteIndex(prev => (prev + 1) % filteredCommands.length);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setPaletteIndex(prev => (prev - 1 + filteredCommands.length) % filteredCommands.length);
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          executeSlashCommand(filteredCommands[paletteIndex].name);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setPaletteOpen(false);
          setValue('');
          return;
        }
        if (e.key === 'Tab') {
          e.preventDefault();
          // Tab-complete the selected command
          setValue(filteredCommands[paletteIndex].name);
          setPaletteOpen(false);
          return;
        }
      }
      if (e.key === 'Escape' && paletteOpen) {
        e.preventDefault();
        setPaletteOpen(false);
        setValue('');
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend, paletteOpen, filteredCommands, paletteIndex, executeSlashCommand],
  );

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    setValue(newValue);

    // Show palette when typing / at start of empty or slash-only input
    const trimmed = newValue.trim();
    if (trimmed.startsWith('/') && !trimmed.includes(' ') && !isStreaming) {
      setPaletteOpen(true);
      setPaletteIndex(0);
    } else {
      setPaletteOpen(false);
    }
  }, [isStreaming]);

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
      {/* Command Palette */}
      {paletteOpen && filteredCommands.length > 0 && (
        <div className="command-palette">
          {filteredCommands.map((cmd, i) => (
            <div
              key={cmd.name}
              className={`command-palette__item ${i === paletteIndex ? 'command-palette__item--active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault(); // prevent textarea blur
                executeSlashCommand(cmd.name);
              }}
              onMouseEnter={() => setPaletteIndex(i)}
            >
              <span className="command-palette__name">{cmd.name}</span>
              <span className="command-palette__desc">{cmd.description}</span>
            </div>
          ))}
        </div>
      )}

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
