import React from 'react';
import { Attachment, Message, StreamSegment } from './types';
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

// ---- Grounding badges ----

interface GroundingSource {
  type: 'file' | 'search' | 'web' | 'store' | 'command';
  label: string;
}

const SOURCE_TOOLS: Record<string, (input: Record<string, unknown>) => GroundingSource | null> = {
  Read: (input) => {
    const p = String(input.file_path || '');
    if (!p) return null;
    const basename = p.split('/').pop() || p;
    return { type: 'file', label: basename };
  },
  Glob: (input) => {
    const pattern = String(input.pattern || '');
    return pattern ? { type: 'search', label: pattern } : null;
  },
  Grep: (input) => {
    const pattern = String(input.pattern || '');
    return pattern ? { type: 'search', label: `/${pattern}/` } : null;
  },
  WebFetch: (input) => {
    const url = String(input.url || '');
    if (!url) return null;
    try {
      return { type: 'web', label: new URL(url).hostname };
    } catch {
      return { type: 'web', label: url.slice(0, 30) };
    }
  },
  WebSearch: (input) => {
    const query = String(input.query || '');
    return query ? { type: 'web', label: query.slice(0, 30) } : null;
  },
  retrieve_content: (input) => {
    const id = String(input.contentId || '');
    return id ? { type: 'store', label: id.slice(0, 16) } : null;
  },
  search_content: (input) => {
    const query = String(input.query || '');
    return query ? { type: 'store', label: query.slice(0, 30) } : null;
  },
  Bash: (input) => {
    const cmd = String(input.command || '');
    if (!cmd) return null;
    const short = cmd.split('\n')[0];
    return { type: 'command', label: short.length > 30 ? short.slice(0, 27) + '...' : short };
  },
};

function extractSources(segments: StreamSegment[]): GroundingSource[] {
  const sources: GroundingSource[] = [];
  const seen = new Set<string>();

  for (const seg of segments) {
    if (seg.type !== 'tool_use') continue;
    const extractor = SOURCE_TOOLS[seg.tool];
    if (!extractor) continue;
    const source = extractor(seg.input);
    if (!source) continue;
    const key = `${source.type}:${source.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push(source);
  }

  return sources;
}

const SOURCE_ICONS: Record<GroundingSource['type'], string> = {
  file: '📄',
  search: '🔍',
  web: '🌐',
  store: '📦',
  command: '⌘',
};

function GroundingBadges({ sources }: { sources: GroundingSource[] }): React.ReactElement | null {
  if (sources.length === 0) return null;

  // Show at most 5 badges; collapse the rest
  const visible = sources.slice(0, 5);
  const overflowCount = sources.length - visible.length;

  return (
    <div className="grounding-badges">
      {visible.map((s, i) => (
        <span key={i} className={`grounding-badge grounding-badge--${s.type}`} title={s.label}>
          <span className="grounding-badge__icon">{SOURCE_ICONS[s.type]}</span>
          <span className="grounding-badge__label">{s.label}</span>
        </span>
      ))}
      {overflowCount > 0 && (
        <span className="grounding-badge grounding-badge--overflow">+{overflowCount}</span>
      )}
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

  // Extract grounding sources from assistant segments
  const groundingSources = !isUser && message.segments ? extractSources(message.segments) : [];

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
      {groundingSources.length > 0 && <GroundingBadges sources={groundingSources} />}
      {timeLabel && (
        <div className="message-bubble__timestamp" aria-label={`Sent at ${timeLabel}`}>
          {timeLabel}
        </div>
      )}
    </div>
  );
}
