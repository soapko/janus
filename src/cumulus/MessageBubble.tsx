import React from 'react';
import { Attachment, Message } from './types';
import MarkdownRenderer from './MarkdownRenderer';

interface MessageBubbleProps {
  message: Message;
}

function formatTimestamp(timestamp: number | string): string {
  try {
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

/** Detect if user message contains rich content that needs full-width rendering */
function hasRichContent(text: string): boolean {
  return /```/.test(text) || text.split('\n').length > 3;
}

function getExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toUpperCase() : '?';
}

function AttachmentBlock({ attachments }: { attachments: Attachment[] }): React.ReactElement {
  return (
    <div className="msg-attachments">
      {attachments.map((att) => (
        att.type === 'image' ? (
          <div key={att.id} className="msg-attachment msg-attachment--image">
            <img
              className="msg-attachment__thumb"
              src={`file://${att.path}`}
              alt={att.name}
            />
            <span className="msg-attachment__name">{att.name}</span>
          </div>
        ) : (
          <div key={att.id} className="msg-attachment msg-attachment--file">
            <span className="msg-attachment__file-icon">{getExtension(att.name)}</span>
            <span className="msg-attachment__name">{att.name}</span>
          </div>
        )
      ))}
    </div>
  );
}

export default function MessageBubble({ message }: MessageBubbleProps): React.ReactElement {
  const isUser = message.role === 'user';
  const timeLabel = formatTimestamp(message.timestamp);
  const hasAttachments = isUser && message.attachments && message.attachments.length > 0;
  const hasText = message.content.trim().length > 0;
  const isRichUser = isUser && hasRichContent(message.content);

  const bubbleClass = isRichUser || hasAttachments
    ? 'message-bubble message-bubble--user message-bubble--user-rich'
    : `message-bubble message-bubble--${message.role}`;

  return (
    <div className={bubbleClass}>
      <div className="message-bubble__content">
        {hasAttachments && (
          <AttachmentBlock attachments={message.attachments!} />
        )}
        {hasText && (
          isUser && !isRichUser && !hasAttachments ? (
            <p className="message-bubble__user-text">{message.content}</p>
          ) : (
            <MarkdownRenderer content={message.content} />
          )
        )}
      </div>
      {timeLabel && (
        <div className="message-bubble__timestamp" aria-label={`Sent at ${timeLabel}`}>
          {timeLabel}
        </div>
      )}
    </div>
  );
}
