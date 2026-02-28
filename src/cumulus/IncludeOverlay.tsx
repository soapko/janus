import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { CumulusChatAPI, IncludeFileInfo } from './types';

interface IncludeOverlayProps {
  api: CumulusChatAPI;
  onClose: () => void;
}

type Mode = 'list' | 'add';

export default function IncludeOverlay({ api, onClose }: IncludeOverlayProps): React.ReactElement {
  const [mode, setMode] = useState<Mode>('list');
  const [files, setFiles] = useState<IncludeFileInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  // Add mode state
  const [addPath, setAddPath] = useState('');
  const [addScope, setAddScope] = useState<'global' | 'thread'>('thread');
  const [adding, setAdding] = useState(false);
  const addInputRef = useRef<HTMLInputElement>(null);

  const loadFiles = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.listIncludeFiles();
      setFiles(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    loadFiles();
  }, [loadFiles]);

  useEffect(() => {
    if (mode === 'add' && addInputRef.current) {
      addInputRef.current.focus();
    }
  }, [mode]);

  // Escape key closes overlay
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (mode === 'add') {
          setMode('list');
          setAddPath('');
        } else {
          onClose();
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [mode, onClose]);

  const handleRemove = useCallback(async (filePath: string, scope: 'global' | 'thread') => {
    setError(null);
    try {
      await api.removeIncludeFile(filePath, scope);
      setConfirmRemove(null);
      await loadFiles();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [api, loadFiles]);

  const handleAdd = useCallback(async () => {
    const trimmed = addPath.trim();
    if (!trimmed) return;
    setAdding(true);
    setError(null);
    try {
      await api.addIncludeFile(trimmed, addScope);
      setAddPath('');
      setMode('list');
      await loadFiles();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  }, [addPath, addScope, api, loadFiles]);

  const handleAddKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAdd();
    }
  }, [handleAdd]);

  if (mode === 'add') {
    return (
      <div className="slash-overlay">
        <div className="slash-overlay__header">
          <span className="slash-overlay__title">Add Always-Include File</span>
        </div>
        <div className="slash-overlay__body">
          {error && <div className="slash-overlay__error">{error}</div>}
          <div className="include-add-form">
            <label className="include-add-form__label">File path:</label>
            <input
              ref={addInputRef}
              className="include-add-form__input"
              type="text"
              value={addPath}
              onChange={e => setAddPath(e.target.value)}
              onKeyDown={handleAddKeyDown}
              placeholder="src/utils/helpers.ts"
              disabled={adding}
            />
            <div className="include-add-form__scope">
              <span className="include-add-form__scope-label">Scope:</span>
              <button
                className={`include-add-form__scope-btn ${addScope === 'global' ? 'include-add-form__scope-btn--active' : ''}`}
                onClick={() => setAddScope('global')}
                type="button"
              >
                Global
              </button>
              <button
                className={`include-add-form__scope-btn ${addScope === 'thread' ? 'include-add-form__scope-btn--active' : ''}`}
                onClick={() => setAddScope('thread')}
                type="button"
              >
                Thread
              </button>
            </div>
            <div className="include-add-form__actions">
              <button
                className="slash-overlay__btn slash-overlay__btn--primary"
                onClick={handleAdd}
                disabled={!addPath.trim() || adding}
                type="button"
              >
                {adding ? 'Adding...' : 'Add'}
              </button>
              <button
                className="slash-overlay__btn"
                onClick={() => { setMode('list'); setAddPath(''); setError(null); }}
                type="button"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="slash-overlay">
      <div className="slash-overlay__header">
        <span className="slash-overlay__title">Always-Include Files</span>
      </div>
      <div className="slash-overlay__body">
        {error && <div className="slash-overlay__error">{error}</div>}

        {loading ? (
          <div className="slash-overlay__loading">Loading...</div>
        ) : files.length === 0 ? (
          <div className="slash-overlay__empty">No always-include files configured.</div>
        ) : (
          <div className="include-file-list">
            {files.map(file => (
              <div key={`${file.scope}:${file.path}`} className="include-file-item">
                <div className="include-file-item__row">
                  <span className="include-file-item__path">{file.path}</span>
                  <span className={`include-file-item__scope include-file-item__scope--${file.scope}`}>
                    {file.scope}
                  </span>
                  <button
                    className="include-file-item__remove-btn"
                    onClick={() => setConfirmRemove(`${file.scope}:${file.path}`)}
                    type="button"
                    title="Remove"
                  >
                    &times;
                  </button>
                </div>
                {confirmRemove === `${file.scope}:${file.path}` && (
                  <div className="include-file-item__confirm">
                    <span>Remove this file?</span>
                    <button
                      className="slash-overlay__btn slash-overlay__btn--danger"
                      onClick={() => handleRemove(file.path, file.scope)}
                      type="button"
                    >
                      Yes
                    </button>
                    <button
                      className="slash-overlay__btn"
                      onClick={() => setConfirmRemove(null)}
                      type="button"
                    >
                      No
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="slash-overlay__footer">
        <button
          className="slash-overlay__btn slash-overlay__btn--primary"
          onClick={() => { setMode('add'); setError(null); }}
          type="button"
        >
          + Add file
        </button>
        <button
          className="slash-overlay__btn"
          onClick={onClose}
          type="button"
        >
          Done
        </button>
      </div>
    </div>
  );
}
