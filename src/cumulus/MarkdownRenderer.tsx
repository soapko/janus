import React, { useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';

declare global {
  interface Window {
    electronAPI?: {
      openExternal: (url: string) => Promise<void>;
      openPath: (filePath: string) => Promise<void>;
    };
  }
}

interface MarkdownRendererProps {
  content: string;
}

interface CodeProps {
  className?: string;
  children?: React.ReactNode;
  [key: string]: unknown;
}

/** Regex to detect absolute file paths in text */
const FILE_PATH_RE = /(?:~\/|\/(?:Users|home|tmp|var|etc|opt|usr|private)\/)[^\s<>{}()\[\]"'`]+/g;

/** Test if an entire string is a file path (for inline code detection) */
const IS_FILE_PATH_RE = /^(?:~\/|\$\w+\/|\.\.?\/|\/(?:Users|home|tmp|var|etc|opt|usr|private)\/)[\S]+$/;

/** Test if a string looks like a URL */
const IS_URL_RE = /^https?:\/\/\S+$/;

/** Pre-process markdown text to linkify raw file paths that aren't already inside links/code */
function linkifyFilePaths(content: string): string {
  // Split by code blocks and inline code to avoid processing code content
  const parts: string[] = [];
  let lastIndex = 0;
  // Match fenced code blocks and inline code
  const codeRe = /```[\s\S]*?```|`[^`\n]+`/g;
  let codeMatch: RegExpExecArray | null;

  while ((codeMatch = codeRe.exec(content)) !== null) {
    // Process the text before this code block
    parts.push(linkifyPathsInText(content.slice(lastIndex, codeMatch.index)));
    // Keep code block unchanged
    parts.push(codeMatch[0]);
    lastIndex = codeMatch.index + codeMatch[0].length;
  }
  // Process remaining text
  parts.push(linkifyPathsInText(content.slice(lastIndex)));

  return parts.join('');
}

function linkifyPathsInText(text: string): string {
  // Don't process text that's already inside markdown link syntax
  // We do a simple replacement — if the path is already a link target, skip it
  return text.replace(FILE_PATH_RE, (match, offset) => {
    // Check if this path is already inside a markdown link [text](path) or <path>
    const before = text.slice(Math.max(0, offset - 2), offset);
    if (before.endsWith('](') || before.endsWith('<')) return match;
    // Check if preceded by a markdown image ![
    const beforeImg = text.slice(Math.max(0, offset - 4), offset);
    if (beforeImg.includes('![')) return match;

    // Clean trailing punctuation that's likely sentence-ending
    let cleaned = match.replace(/[.,;:!?)]+$/, '');
    const trailing = match.slice(cleaned.length);

    // Wrap in markdown link with file:// protocol
    return `[${cleaned}](file://${cleaned})${trailing}`;
  });
}

function CodeBlock({
  className,
  children,
  ...props
}: CodeProps): React.ReactElement {
  const match = /language-(\w+)/.exec(className ?? '');
  const language = match ? match[1] : '';
  const codeText = String(children ?? '').replace(/\n$/, '');

  // react-markdown v6+ no longer passes an `inline` prop.
  // Detect inline code: no language class and content has no newlines.
  const isInline = !match && !codeText.includes('\n');

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(codeText).catch(() => {
      const textarea = document.createElement('textarea');
      textarea.value = codeText;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    });
  }, [codeText]);

  if (isInline) {
    // Detect file paths and URLs inside inline code and make them clickable
    const trimmed = codeText.replace(/[.,;:!?)]+$/, '');
    if (IS_FILE_PATH_RE.test(trimmed)) {
      return (
        <code className={`${className ?? ''} clickable-path`.trim()} {...props}
          onClick={() => window.electronAPI?.openPath(trimmed)}
          title={`Open: ${trimmed}`}
          role="link"
        >
          {children}
        </code>
      );
    }
    if (IS_URL_RE.test(trimmed)) {
      return (
        <code className={`${className ?? ''} clickable-url`.trim()} {...props}
          onClick={() => window.electronAPI?.openExternal(trimmed)}
          title={trimmed}
          role="link"
        >
          {children}
        </code>
      );
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  }

  return (
    <div className="code-block-wrapper">
      <div className="code-block-header">
        <span className="code-block-language">{language || 'code'}</span>
        <button
          className="code-block-copy-btn"
          onClick={handleCopy}
          type="button"
          aria-label="Copy code to clipboard"
        >
          Copy
        </button>
      </div>
      <pre>
        <code className={className} {...props}>
          {children}
        </code>
      </pre>
    </div>
  );
}

/** Custom link component — routes file:// to openPath, URLs to openExternal */
function ClickableLink({
  href,
  children,
  ...props
}: React.AnchorHTMLAttributes<HTMLAnchorElement>): React.ReactElement {
  const handleClick = useCallback((e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    if (!href) return;

    const api = window.electronAPI;
    if (!api) return;

    if (href.startsWith('file://')) {
      const filePath = decodeURIComponent(href.replace('file://', ''));
      api.openPath(filePath);
    } else if (href.startsWith('http://') || href.startsWith('https://')) {
      api.openExternal(href);
    }
  }, [href]);

  const isFilePath = href?.startsWith('file://');

  return (
    <a
      {...props}
      href={href}
      onClick={handleClick}
      className={isFilePath ? 'clickable-path' : undefined}
      title={isFilePath ? `Open: ${href?.replace('file://', '')}` : href}
    >
      {children}
    </a>
  );
}

export default function MarkdownRenderer({ content }: MarkdownRendererProps): React.ReactElement {
  const processed = linkifyFilePaths(content);

  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          code: CodeBlock as React.ComponentType<React.HTMLAttributes<HTMLElement>>,
          a: ClickableLink as React.ComponentType<React.AnchorHTMLAttributes<HTMLAnchorElement>>,
        }}
      >
        {processed}
      </ReactMarkdown>
    </div>
  );
}
