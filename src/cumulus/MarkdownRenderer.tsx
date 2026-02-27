import React, { useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';

interface MarkdownRendererProps {
  content: string;
}

interface CodeProps {
  className?: string;
  children?: React.ReactNode;
  [key: string]: unknown;
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

export default function MarkdownRenderer({ content }: MarkdownRendererProps): React.ReactElement {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        rehypePlugins={[rehypeHighlight]}
        components={{
          code: CodeBlock as React.ComponentType<React.HTMLAttributes<HTMLElement>>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
