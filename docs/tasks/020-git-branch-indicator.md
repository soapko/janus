# Task 020: Git Branch Indicator (Replace Thread Name)

## Problem

The chat header shows the thread name (e.g., "janus") in `.chat-header__thread-info`. This is low-value information since the tab label already shows the thread name.

Replace it with a **git branch indicator** showing the current branch and unsaved changes count — much more useful context while coding.

## Desired Behavior

Replace the thread name text with:

```
main  3 unsaved
```

Or if clean:

```
main
```

Or on a feature branch:

```
feat/voice-input  12 unsaved
```

The "unsaved" count = number of files with uncommitted changes (staged + unstaged + untracked).

## Implementation

### 1. IPC handlers in `main.js`

Add two new IPC handlers that run `git` commands in the project's working directory:

```javascript
ipcMain.handle('git:get-branch', async (event, cwd) => {
  const { execSync } = require('child_process');
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf8' }).trim();
  } catch {
    return null; // not a git repo
  }
});

ipcMain.handle('git:get-status', async (event, cwd) => {
  const { execSync } = require('child_process');
  try {
    const output = execSync('git status --porcelain', { cwd, encoding: 'utf8' });
    return output.split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
});
```

### 2. Preload API in `preload.js`

```javascript
gitGetBranch: (cwd) => ipcRenderer.invoke('git:get-branch', cwd),
gitGetStatus: (cwd) => ipcRenderer.invoke('git:get-status', cwd),
```

### 3. Wire into cumulus chat API in `renderer.js`

Pass the git functions through the `api` object given to React:

```javascript
gitGetBranch: () => window.electronAPI.gitGetBranch(projectPath),
gitGetStatus: () => window.electronAPI.gitGetStatus(projectPath),
```

### 4. Update types in `src/cumulus/types.ts`

```typescript
gitGetBranch: () => Promise<string | null>;
gitGetStatus: () => Promise<number>;
```

### 5. Update `ChatPanel.tsx`

Replace the thread name span with a git branch indicator:

```tsx
const [gitBranch, setGitBranch] = useState<string | null>(null);
const [gitDirtyCount, setGitDirtyCount] = useState(0);

useEffect(() => {
  const refresh = () => {
    api.gitGetBranch().then(setGitBranch);
    api.gitGetStatus().then(setGitDirtyCount);
  };
  refresh();
  const interval = setInterval(refresh, 5000); // poll every 5s
  return () => clearInterval(interval);
}, []);

// In JSX:
<div className="chat-header__thread-info">
  {gitBranch ? (
    <>
      <span className="chat-header__git-branch">{gitBranch}</span>
      {gitDirtyCount > 0 && (
        <span className="chat-header__git-dirty">{gitDirtyCount} unsaved</span>
      )}
    </>
  ) : (
    <span className="chat-header__thread-name">{api.threadName}</span>
  )}
</div>
```

Falls back to thread name if not a git repo.

### 6. CSS in `chat.css`

```css
.chat-header__git-branch {
  font-size: 0.85em;
  font-weight: 600;
  color: #8be9fd; /* cyan — stands out as "status" info */
  font-family: 'SF Mono', 'Fira Code', monospace;
}

.chat-header__git-dirty {
  font-size: 0.75em;
  color: #f1fa8c; /* yellow — attention */
  font-weight: 500;
}
```

### Files to modify

| File | Change |
|------|--------|
| `main.js` | Add `git:get-branch` and `git:get-status` IPC handlers |
| `preload.js` | Expose `gitGetBranch` and `gitGetStatus` |
| `renderer.js` | Pass git functions through cumulus chat API |
| `src/cumulus/types.ts` | Add git method types to `CumulusChatAPI` |
| `src/cumulus/ChatPanel.tsx` | Replace thread name with git branch + dirty count |
| `src/cumulus/chat.css` | Add git indicator styles |

### Edge cases

- Not a git repo → `gitGetBranch` returns null → falls back to showing thread name
- Detached HEAD → shows commit hash instead of branch name (git's default behavior)
- Large repo with many changes → `git status --porcelain` is fast enough for 5s polling
- Per-thread cwd resolution → uses the resolved project path (already handled by renderer.js)

## Testing

1. Launch Janus in a git repo, verify branch name appears (e.g., "main")
2. Make a change to a file, wait 5s, verify unsaved count appears
3. Stage and commit, verify count drops to 0
4. Switch git branches, verify indicator updates
5. Open a project that's not a git repo, verify thread name is shown as fallback
