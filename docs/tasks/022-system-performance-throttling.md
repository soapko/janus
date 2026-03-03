# Task 022: System-Level Performance Throttling

## Overview

When 8+ agents run simultaneously, Janus spawns 24+ Node.js processes (1 Claude CLI + 2 MCP servers per agent), consuming 2-3GB+ RAM and saturating CPU. This task introduces a two-layer throttling system: a **SystemHealthMonitor** that polls OS metrics and a **SubprocessPool** that gates all Claude subprocess spawning based on system health.

## Layered Model

```
Layer 1 (existing - task 021): Per-agent message queue
  Messages to BUSY agents are queued.
  Drains when agent finishes its turn.

Layer 2 (NEW - this task): Global subprocess concurrency pool
  Even if an agent is IDLE, don't spawn if system is overloaded.
  Requests queue in the pool and execute when capacity frees up.
  Pool max-concurrency adapts based on system health score.
```

## Control Flow

```
User/Agent message arrives
  -> injectMessage() checks if agent is streaming
    -> BUSY: queue in per-agent messageQueue (Layer 1, unchanged)
    -> IDLE: call sendMessage()
      -> sendMessage() calls pool.acquire() (Layer 2, NEW)
        -> Pool has capacity: spawn immediately
        -> Pool full: queue in spawn-wait-queue, resolve when slot opens
      -> spawn() runs, subprocess starts
      -> On subprocess exit:
        -> pool.release() frees the slot (Layer 2)
        -> drainQueue() delivers pending messages (Layer 1)
        -> Pool processes next waiting spawn if any
```

## Files

### New Files
| File | Purpose |
|------|---------|
| `system-health.js` | SystemHealthMonitor — polls OS metrics, emits throttle level changes |
| `subprocess-pool.js` | SubprocessPool — concurrency gate with health-adaptive limits |

### Modified Files
| File | Change |
|------|--------|
| `cumulus-bridge.js` | Accept pool via constructor, gate `sendMessage()` through `pool.acquire()`/`pool.release()` |
| `main.js` | Instantiate monitor + pool, inject pool into bridges, add `GET /api/system/health` endpoint |

## SystemHealthMonitor

- Polls `os.loadavg()[0]` and `os.freemem()` every 3 seconds
- Computes degradation score 0-100 (CPU 60% weight, memory 40%)
- Hysteresis: 5-point buffer to prevent flapping between levels
- Emits `level-change` events: `green` → `yellow` → `red`

| Level | Score | Meaning |
|-------|-------|---------|
| green | 0-39 | Full throughput (6 concurrent) |
| yellow | 40-69 | Reduce concurrency (3 concurrent) |
| red | 70-100 | Minimum concurrency (2 concurrent) |

## SubprocessPool

- `acquire(threadName)` — returns Promise, resolves when slot available
- `release(threadName)` — frees slot, drains wait queue
- `setHealthLevel(level)` — adjusts maxConcurrency dynamically
- FIFO wait queue for spawn requests when pool is full

## Edge Cases

- **Pool slot always released**: Two exit paths (`handleCompletion` and `error`), both call `pool.release()`
- **Bridge destroyed while queued**: `_destroyed` flag check after `acquire()` resolves
- **No npm dependencies**: Uses only Node.js built-ins (`events`, `os`)
- **No deadlock**: Claude CLI subprocesses always terminate (5-30s typical)
