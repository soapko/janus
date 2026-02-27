# Task 013: React Chat UI

## Overview

Build the React chat interface that mounts into Cumulus-type tab panels. Uses esbuild to bundle React components into a single JS file that the vanilla JS renderer can load.

## Dependencies

- Task 011 (universal tab model) - cumulus tab type stub exists
- Task 012 (cumulus lib integration) - IPC bridge exists for send/stream

## Architecture

Hybrid rendering approach:
- Tab bar, panel layout, resize handles: vanilla JS (renderer.js)
- Cumulus tab panel content: React (mounted via `createRoot`)
- React bundle loaded as a `<script>` tag, exposes `mountCumulusChat(container, api)` globally

## Implementation Steps

### 1. React Build Pipeline

Add dev dependencies:
```json
{
  "devDependencies": {
    "esbuild": "^0.25.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "typescript": "^5.7.0"
  }
}
```

Add runtime dependencies:
```json
{
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-markdown": "^9.0.0",
    "rehype-highlight": "^7.0.0"
  }
}
```

Add npm script:
```json
{
  "scripts": {
    "build:chat": "esbuild src/cumulus/index.tsx --bundle --outfile=dist/cumulus-chat.js --platform=browser --target=chrome120 --loader:.css=css --define:process.env.NODE_ENV='\"production\"'",
    "watch:chat": "esbuild src/cumulus/index.tsx --bundle --outfile=dist/cumulus-chat.js --platform=browser --target=chrome120 --watch"
  }
}
```

### 2. TypeScript Config for React

Create `src/cumulus/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "moduleResolution": "bundler",
    "outDir": "../../dist"
  },
  "include": ["./**/*.ts", "./**/*.tsx"]
}
```

### 3. Entry Point (`src/cumulus/index.tsx`)

```tsx
import { createRoot, Root } from 'react-dom/client';
import { ChatPanel } from './ChatPanel';

interface CumulusChatAPI {
  sendMessage: (message: string) => void;
  onStreamChunk: (callback: (chunk: string) => void) => void;
  onStreamEnd: (callback: (data: { fullResponse: string }) => void) => void;
  getHistory: (count: number) => Promise<Message[]>;
  threadName: string;
}

// Expose mount function globally for vanilla JS to call
(window as any).mountCumulusChat = (container: HTMLElement, api: CumulusChatAPI): Root => {
  const root = createRoot(container);
  root.render(<ChatPanel api={api} />);
  return root;
};
```

### 4. ChatPanel Component (`src/cumulus/ChatPanel.tsx`)

Main component containing message list + input area.

State:
- `messages: Message[]` - loaded from history on mount
- `streamBuffer: string` - accumulated streaming response
- `isProcessing: boolean` - waiting for Claude response
- `error: string | null`

Layout:
```
┌──────────────────────────────┐
│  Thread: project-name        │  <- header with thread name
├──────────────────────────────┤
│                              │
│  [user message]              │  <- scrollable message list
│  [assistant response]        │
│  [user message]              │
│  [streaming response...]     │  <- live streaming area
│                              │
├──────────────────────────────┤
│  [input area] [Send]         │  <- fixed at bottom
└──────────────────────────────┘
```

### 5. ChatInput Component (`src/cumulus/ChatInput.tsx`)

- Textarea that grows with content (auto-resize)
- Enter to send (Shift+Enter for newline)
- Disabled while processing
- Clear on send

### 6. MessageBubble Component (`src/cumulus/MessageBubble.tsx`)

- Renders a single message (user or assistant)
- User messages: simple text, right-aligned or distinct styling
- Assistant messages: rendered through MarkdownRenderer
- Timestamp display

### 7. StreamingResponse Component (`src/cumulus/StreamingResponse.tsx`)

- Renders the in-progress streaming text
- Blinking cursor at end
- Auto-scrolls to bottom
- Rendered through MarkdownRenderer (may lag for performance)

### 8. MarkdownRenderer Component (`src/cumulus/MarkdownRenderer.tsx`)

- Uses `react-markdown` with `rehype-highlight` for syntax highlighting
- Code blocks with copy button
- Proper styling for headers, lists, tables, links
- Dark theme consistent with Janus

### 9. Styles

CSS for the chat UI. Options:
- Inline styles in components (simplest, no build config)
- CSS file imported by esbuild (cleaner)
- CSS modules

Recommended: Single CSS file (`src/cumulus/chat.css`) bundled by esbuild.

Dark theme matching Janus:
- Background: `#1a1a1a` (slightly lighter than terminal black)
- User messages: `#2d2d2d` background
- Assistant messages: transparent
- Accent: `#0066cc` (matching Janus blue)
- Text: `#e0e0e0`
- Code blocks: `#1e1e1e` background

### 10. Integration with Renderer

In `renderer.js`, the cumulus tab creation:

```javascript
function createCumulusTab(threadName) {
  const tab = createTab('cumulus', { label: threadName || 'Chat' });

  const container = document.createElement('div');
  container.className = 'cumulus-chat-container';
  tab.panelEl.appendChild(container);

  const api = {
    sendMessage: (msg) => window.electronAPI.cumulusSendMessage(threadName, msg),
    onStreamChunk: (cb) => window.electronAPI.onCumulusStreamChunk(cb),
    onStreamEnd: (cb) => window.electronAPI.onCumulusStreamEnd(cb),
    getHistory: (n) => window.electronAPI.cumulusGetHistory(threadName, n),
    threadName
  };

  const root = window.mountCumulusChat(container, api);
  tab.typeState = { reactRoot: root, threadId: threadName };
}
```

## Loading the Bundle

In `index.html`:
```html
<script src="dist/cumulus-chat.js"></script>
```

The `build:chat` script must run before `npm start`. Update the start script:
```json
"start": "npm run build:chat && electron-forge start"
```

## Testing

- Build the React bundle successfully (`npm run build:chat`)
- Create a cumulus tab, verify React mounts
- Send a message, verify it appears in the chat
- Claude responds with streaming text
- Markdown renders correctly (code blocks, headers, lists)
- Code blocks have syntax highlighting
- Copy button on code blocks works
- Chat auto-scrolls during streaming
- Multiple cumulus tabs work independently
- Closing a cumulus tab unmounts React cleanly
- Dark theme matches Janus styling
