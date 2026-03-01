import React from 'react';
import { Attachment, Message } from './types';
import MarkdownRenderer from './MarkdownRenderer';
import { renderSegmentGroups } from './StreamingResponse';

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

/** Deterministic color from agent name — 6 visually distinct hues */
const AGENT_COLORS = [
  '#9966cc', // purple
  '#2aa198', // teal
  '#e69500', // orange
  '#d33682', // rose
  '#85c025', // lime
  '#ff6b6b', // coral
];

function agentColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  return AGENT_COLORS[Math.abs(hash) % AGENT_COLORS.length];
}

/** Parse inter-agent message prefix: [From agent "name"]: and strip reply hint */
function parseAgentMessage(content: string): { agentName: string; body: string } | null {
  const match = content.match(/^\[From agent "([^"]+)"\]:\n([\s\S]+)$/);
  if (!match) return null;
  // Strip the reply hint line (parenthetical at the end starting with "Reply using send_to_agent")
  const body = match[2].replace(/\n*\(Reply using send_to_agent\([\s\S]*$/, '').trim();
  return { agentName: match[1], body };
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
  const hasVerboseSegments = !isUser && message.segments && message.segments.some((s) => s.type !== 'text');

  // Detect inter-agent messages
  const agentInfo = isUser ? parseAgentMessage(message.content) : null;

  if (agentInfo) {
    const color = agentColor(agentInfo.agentName);
    return (
      <div className="message-bubble message-bubble--agent" style={{ '--agent-color': color } as React.CSSProperties}>
        <div className="message-bubble__agent-tag">{agentInfo.agentName}</div>
        <div className="message-bubble__content">
          <MarkdownRenderer content={agentInfo.body} />
        </div>
        {timeLabel && (
          <div className="message-bubble__timestamp" aria-label={`Sent at ${timeLabel}`}>
            {timeLabel}
          </div>
        )}
      </div>
    );
  }

  const bubbleClass = isRichUser || hasAttachments
    ? 'message-bubble message-bubble--user message-bubble--user-rich'
    : `message-bubble message-bubble--${message.role}`;

  return (
    <div className={bubbleClass}>
      <div className="message-bubble__content">
        {hasAttachments && (
          <AttachmentBlock attachments={message.attachments!} />
        )}
        {hasVerboseSegments ? (
          renderSegmentGroups(message.segments!)
        ) : hasText ? (
          isUser && !isRichUser && !hasAttachments ? (
            <p className="message-bubble__user-text">{message.content}</p>
          ) : (
            <MarkdownRenderer content={message.content} />
          )
        ) : null}
      </div>
      {timeLabel && (
        <div className="message-bubble__timestamp" aria-label={`Sent at ${timeLabel}`}>
          {timeLabel}
        </div>
      )}
    </div>
  );
}
