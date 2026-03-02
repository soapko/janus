# 019: Clickable File Paths & Grounding Badges

## Overview

Two enhancements to the Janus chat UI:

1. **Clickable file paths & URLs** — Raw file paths like `/Users/karl/foo.ts` and URLs like `https://example.com` in markdown content become clickable. File paths open in Finder/default app, URLs open in default browser.

2. **Grounding badges** — Assistant messages that used tools to read files, fetch content, or search show subtle source badges below the message content. Shows what data the response is grounded in.

## Implementation

### 1. preload.js — Expose shell.open APIs

Add two new IPC methods:
- `openExternal(url)` — calls `shell.openExternal(url)` for URLs
- `openPath(filePath)` — calls `shell.openPath(filePath)` for local files

### 2. main.js — Register IPC handlers

Handle `shell:open-external` and `shell:open-path` in main process.

### 3. MarkdownRenderer.tsx — Linkify raw paths

Add a custom `remarkPlugin` that detects:
- Absolute file paths: `/Users/...`, `/home/...`, `/tmp/...`, `~/...`
- Raw URLs not already in markdown links

Convert them to clickable `<a>` tags. Override the `a` component to use `window.electronAPI.openExternal()` / `openPath()` instead of default navigation.

### 4. MessageBubble.tsx — Extract and render grounding badges

Extract "sources" from `message.segments` (tool_use segments):
- `Read`, `Glob`, `Grep` → file paths
- `WebFetch`, `WebSearch` → URLs/queries
- `retrieve_content`, `search_content` → content store references
- `Bash` → command executed

Render as small chips below the message content, before the timestamp.

### 5. chat.css — Styles

- Source badges: small, subtle chips with monospace font
- Clickable paths in markdown: styled like links but with a subtle file/link icon

## Files Modified

- `preload.js`
- `main.js`
- `src/cumulus/MarkdownRenderer.tsx`
- `src/cumulus/MessageBubble.tsx`
- `src/cumulus/chat.css`
