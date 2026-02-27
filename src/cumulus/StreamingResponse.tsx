import React from 'react';
import MarkdownRenderer from './MarkdownRenderer';

interface StreamingResponseProps {
  text: string;
}

export default function StreamingResponse({ text }: StreamingResponseProps): React.ReactElement {
  return (
    <div className="streaming-response">
      <div className="streaming-response__content">
        <MarkdownRenderer content={text} />
      </div>
      <span className="streaming-cursor" aria-hidden="true" />
    </div>
  );
}
