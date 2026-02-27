import './chat.css';

import React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { CumulusChatAPI } from './types';
import ChatPanel from './ChatPanel';

/**
 * Mount the Cumulus chat UI into the given container element.
 *
 * @param container - The DOM element to render into (provided by the Janus shell)
 * @param api       - The CumulusChatAPI instance wrapping Electron IPC
 * @returns         The React root so the caller can later unmount via unmountCumulusChat
 */
function mountCumulusChat(container: HTMLElement, api: CumulusChatAPI): Root {
  const root = createRoot(container);
  root.render(
    <React.StrictMode>
      <ChatPanel api={api} />
    </React.StrictMode>,
  );
  return root;
}

/**
 * Cleanly unmount a previously mounted chat UI.
 *
 * @param root - The React root returned by mountCumulusChat
 */
function unmountCumulusChat(root: Root): void {
  root.unmount();
}

// Expose on window for the vanilla JS Janus shell to call
declare global {
  interface Window {
    mountCumulusChat: typeof mountCumulusChat;
    unmountCumulusChat: typeof unmountCumulusChat;
  }
}

window.mountCumulusChat = mountCumulusChat;
window.unmountCumulusChat = unmountCumulusChat;
