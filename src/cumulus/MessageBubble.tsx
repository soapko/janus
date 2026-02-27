import React from 'react';
import { Message } from './types';
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

export default function MessageBubble({ message }: MessageBubbleProps): React.ReactElement {
  const isUser = message.role === 'user';
  const timeLabel = formatTimestamp(message.timestamp);
  const isRichUser = isUser && hasRichContent(message.content);

  const bubbleClass = isRichUser
    ? 'message-bubble message-bubble--user message-bubble--user-rich'
    : `message-bubble message-bubble--${message.role}`;

  return (
    <div className={bubbleClass}>
      <div className="message-bubble__content">
        {isUser && !isRichUser ? (
          <p className="message-bubble__user-text">{message.content}</p>
        ) : (
          <MarkdownRenderer content={message.content} />
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
