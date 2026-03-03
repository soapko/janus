/**
 * SubprocessPool - Concurrency-limited pool for Claude subprocess spawning.
 *
 * Gates all subprocess spawns through acquire()/release(). Max concurrency
 * adapts based on system health level from SystemHealthMonitor.
 *
 * No external dependencies — uses only Node.js built-ins.
 */

class SubprocessPool {
  constructor(options = {}) {
    this.baseConcurrency = options.baseConcurrency || 6;
    this.minConcurrency = options.minConcurrency || 2;
    this.active = 0;
    this.maxConcurrency = this.baseConcurrency;
    this.waitQueue = []; // { resolve, threadName, timestamp }
    this.level = 'green';
  }

  setHealthLevel(level) {
    this.level = level;
    switch (level) {
      case 'green':
        this.maxConcurrency = this.baseConcurrency;
        break;
      case 'yellow':
        this.maxConcurrency = Math.max(
          this.minConcurrency,
          Math.floor(this.baseConcurrency * 0.5)
        );
        break;
      case 'red':
        this.maxConcurrency = this.minConcurrency;
        break;
    }
    // If concurrency increased, drain waiting spawns
    this._drainWaitQueue();
    console.log(`[Pool] Health: ${level}, max: ${this.maxConcurrency}, active: ${this.active}, queued: ${this.waitQueue.length}`);
  }

  acquire(threadName) {
    if (this.active < this.maxConcurrency) {
      this.active++;
      console.log(`[Pool] Acquired slot for "${threadName}" (${this.active}/${this.maxConcurrency})`);
      return Promise.resolve();
    }
    console.log(`[Pool] Queuing "${threadName}" (${this.active}/${this.maxConcurrency}, ${this.waitQueue.length + 1} waiting)`);
    return new Promise((resolve) => {
      this.waitQueue.push({ resolve, threadName, timestamp: Date.now() });
    });
  }

  release(threadName) {
    this.active = Math.max(0, this.active - 1);
    console.log(`[Pool] Released slot for "${threadName}" (${this.active}/${this.maxConcurrency})`);
    this._drainWaitQueue();
  }

  _drainWaitQueue() {
    while (this.waitQueue.length > 0 && this.active < this.maxConcurrency) {
      const next = this.waitQueue.shift();
      this.active++;
      const waitMs = Date.now() - next.timestamp;
      console.log(`[Pool] Dequeued "${next.threadName}" after ${waitMs}ms wait (${this.active}/${this.maxConcurrency})`);
      next.resolve();
    }
  }

  getStatus() {
    return {
      active: this.active,
      maxConcurrency: this.maxConcurrency,
      baseConcurrency: this.baseConcurrency,
      minConcurrency: this.minConcurrency,
      level: this.level,
      queueLength: this.waitQueue.length,
      queuedAgents: this.waitQueue.map(w => w.threadName),
    };
  }
}

module.exports = { SubprocessPool };
