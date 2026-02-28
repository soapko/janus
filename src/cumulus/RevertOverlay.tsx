import React, { useCallback, useEffect, useState } from 'react';
import type { CumulusChatAPI, TurnInfo } from './types';

interface RevertOverlayProps {
  api: CumulusChatAPI;
  onClose: () => void;
  onReverted: () => void;
}

type Mode = 'pick' | 'confirm';

export default function RevertOverlay({ api, onClose, onReverted }: RevertOverlayProps): React.ReactElement {
  const [mode, setMode] = useState<Mode>('pick');
  const [turns, setTurns] = useState<TurnInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedTurn, setSelectedTurn] = useState<TurnInfo | null>(null);
  const [restoreGit, setRestoreGit] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    api.getTurns()
      .then(result => {
        setTurns(result);
        setLoading(false);
      })
      .catch(err => {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  }, [api]);

  // Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (mode === 'confirm') {
          setMode('pick');
          setSelectedTurn(null);
        } else {
          onClose();
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [mode, onClose]);

  const handleSelect = useCallback((turn: TurnInfo) => {
    setSelectedTurn(turn);
    setRestoreGit(false);
    setMode('confirm');
  }, []);

  const handleRevert = useCallback(async () => {
    if (!selectedTurn) return;
    setReverting(true);
    setError(null);
    try {
      const result = await api.revert(selectedTurn.id, restoreGit);
      if (result.success) {
        setToast(`Reverted — removed ${result.removedCount} message${result.removedCount === 1 ? '' : 's'}`);
        setTimeout(() => {
          onReverted();
        }, 1200);
      } else {
        setError(result.error || 'Revert failed');
        setReverting(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setReverting(false);
    }
  }, [selectedTurn, restoreGit, api, onReverted]);

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const truncate = (text: string, max: number) => {
    if (text.length <= max) return text;
    return text.slice(0, max) + '...';
  };

  if (toast) {
    return (
      <div className="slash-overlay">
        <div className="slash-overlay__toast">{toast}</div>
      </div>
    );
  }

  // Count messages that would be removed
  const messagesAfterTurn = selectedTurn
    ? turns.filter(t => t.timestamp > selectedTurn.timestamp).length * 2 // rough: each turn = user + assistant
    : 0;

  if (mode === 'confirm' && selectedTurn) {
    return (
      <div className="slash-overlay">
        <div className="slash-overlay__header">
          <span className="slash-overlay__title">Revert to after this turn?</span>
        </div>
        <div className="slash-overlay__body">
          {error && <div className="slash-overlay__error">{error}</div>}
          <div className="revert-confirm">
            <div className="revert-confirm__preview">
              <span className="revert-confirm__label">Keep up to:</span>
              <span className="revert-confirm__text">"{truncate(selectedTurn.userMessage, 60)}"</span>
            </div>
            <div className="revert-confirm__info">
              This will remove approximately {messagesAfterTurn} message{messagesAfterTurn === 1 ? '' : 's'}.
            </div>
            {selectedTurn.hasSnapshot && (
              <label className="revert-confirm__checkbox">
                <input
                  type="checkbox"
                  checked={restoreGit}
                  onChange={e => setRestoreGit(e.target.checked)}
                />
                Also restore code to that point (git snapshot available)
              </label>
            )}
            <div className="revert-confirm__actions">
              <button
                className="slash-overlay__btn slash-overlay__btn--danger"
                onClick={handleRevert}
                disabled={reverting}
                type="button"
              >
                {reverting ? 'Reverting...' : 'Revert'}
              </button>
              <button
                className="slash-overlay__btn"
                onClick={() => { setMode('pick'); setSelectedTurn(null); setError(null); }}
                disabled={reverting}
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
        <span className="slash-overlay__title">Revert Conversation</span>
      </div>
      <div className="slash-overlay__body">
        {error && <div className="slash-overlay__error">{error}</div>}

        {loading ? (
          <div className="slash-overlay__loading">Loading turns...</div>
        ) : turns.length === 0 ? (
          <div className="slash-overlay__empty">Nothing to revert.</div>
        ) : (
          <div className="revert-turn-list">
            <div className="revert-turn-list__hint">Select a turn to keep everything up to (and including) it:</div>
            {turns.map((turn, i) => (
              <div
                key={turn.id}
                className="revert-turn-item"
                onClick={() => handleSelect(turn)}
              >
                <div className="revert-turn-item__header">
                  <span className="revert-turn-item__num">#{turns.length - i}</span>
                  <span className="revert-turn-item__time">{formatTime(turn.timestamp)}</span>
                  {turn.hasSnapshot && <span className="revert-turn-item__snapshot" title="Git snapshot available">&#x1F500;</span>}
                </div>
                <div className="revert-turn-item__text">{truncate(turn.userMessage, 80)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="slash-overlay__footer">
        <button
          className="slash-overlay__btn"
          onClick={onClose}
          type="button"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
