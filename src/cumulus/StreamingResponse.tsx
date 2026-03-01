import React, { useState } from 'react';
import { StreamSegment } from './types';
import MarkdownRenderer from './MarkdownRenderer';

interface StreamingResponseProps {
  text: string;
  segments?: StreamSegment[];
}

/** Summarize tool input to a short string for display */
function summarizeToolInput(input: Record<string, unknown>): string {
  // Common patterns: file_path, command, pattern, query
  const path = input.file_path || input.path || input.notebook_path;
  if (path) return String(path);
  const cmd = input.command;
  if (cmd) {
    const s = String(cmd);
    return s.length > 80 ? s.slice(0, 77) + '...' : s;
  }
  const pattern = input.pattern;
  if (pattern) return `/${String(pattern)}/`;
  const query = input.query;
  if (query) return String(query);
  // Fallback: first string value
  for (const v of Object.values(input)) {
    if (typeof v === 'string' && v.length > 0) {
      return v.length > 60 ? v.slice(0, 57) + '...' : v;
    }
  }
  return '';
}

function ToolResultContent({ content }: { content: string }): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const lines = content.split('\n');
  const needsTruncation = lines.length > 5;

  if (!needsTruncation || expanded) {
    return (
      <div className="verbose-segment__tool-result-content">
        <pre>{content}</pre>
        {needsTruncation && (
          <button
            className="verbose-segment__expand-btn"
            onClick={() => setExpanded(false)}
            type="button"
          >
            Show less
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="verbose-segment__tool-result-content">
      <pre>{lines.slice(0, 3).join('\n')}</pre>
      <button
        className="verbose-segment__expand-btn"
        onClick={() => setExpanded(true)}
        type="button"
      >
        +{lines.length - 3} more lines
      </button>
    </div>
  );
}

/** Render a single verbose segment */
function VerboseSegment({ segment }: { segment: StreamSegment }): React.ReactElement | null {
  switch (segment.type) {
    case 'thinking':
      return (
        <div className="verbose-segment verbose-segment--thinking">
          {segment.content}
        </div>
      );

    case 'tool_use': {
      const summary = summarizeToolInput(segment.input);
      return (
        <div className="verbose-segment verbose-segment--tool-use">
          <span className="verbose-segment__tool-name">{segment.tool}</span>
          {summary && <span className="verbose-segment__tool-args">{summary}</span>}
        </div>
      );
    }

    case 'tool_result':
      return (
        <div className={`verbose-segment verbose-segment--tool-result${segment.isError ? ' verbose-segment--error' : ''}`}>
          <ToolResultContent content={segment.content} />
        </div>
      );

    case 'system':
      return (
        <div className="verbose-segment verbose-segment--system">
          {segment.content}
        </div>
      );

    case 'result': {
      const parts: string[] = [];
      if (segment.duration_ms) {
        const sec = (segment.duration_ms / 1000).toFixed(1);
        parts.push(`${sec}s`);
      }
      if (segment.usage) {
        parts.push(`${segment.usage.input_tokens.toLocaleString()} in / ${segment.usage.output_tokens.toLocaleString()} out`);
      }
      if (parts.length === 0) return null;
      return (
        <div className="verbose-segment verbose-segment--result">
          {parts.join(' · ')}
        </div>
      );
    }

    default:
      return null;
  }
}

/** Group consecutive segments and render: text as markdown, others as verbose blocks */
export function renderSegmentGroups(segments: StreamSegment[]): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let textAccum = '';

  const flushText = () => {
    if (textAccum) {
      nodes.push(<MarkdownRenderer key={`text-${nodes.length}`} content={textAccum} />);
      textAccum = '';
    }
  };

  for (const seg of segments) {
    if (seg.type === 'text') {
      textAccum += seg.content;
    } else {
      flushText();
      nodes.push(<VerboseSegment key={`seg-${nodes.length}`} segment={seg} />);
    }
  }
  flushText();

  return nodes;
}

export default function StreamingResponse({ text, segments }: StreamingResponseProps): React.ReactElement {
  const hasSegments = segments && segments.length > 0;
  const hasNonTextSegments = hasSegments && segments.some((s) => s.type !== 'text');

  return (
    <div className="streaming-response">
      <div className="streaming-response__content">
        {hasNonTextSegments
          ? renderSegmentGroups(segments)
          : <MarkdownRenderer content={text} />
        }
      </div>
      <span className="streaming-cursor" aria-hidden="true" />
    </div>
  );
}
