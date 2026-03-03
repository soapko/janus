/**
 * SystemHealthMonitor - Polls OS metrics and computes a degradation score.
 *
 * Emits 'level-change' events when the system health transitions between
 * green (healthy), yellow (degraded), and red (critical).
 *
 * No external dependencies — uses only Node.js built-ins.
 */

const { EventEmitter } = require('events');
const os = require('os');

class SystemHealthMonitor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.pollIntervalMs = options.pollIntervalMs || 3000;
    this.timer = null;
    this.currentScore = 0;
    this.currentLevel = 'green';
    this.metrics = {};
    this.coreCount = os.cpus().length;
  }

  start() {
    this.poll();
    this.timer = setInterval(() => this.poll(), this.pollIntervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  poll() {
    const loadAvg1 = os.loadavg()[0];
    const loadRatio = loadAvg1 / this.coreCount;

    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const memUsedRatio = 1 - (freeMem / totalMem);

    // CPU score: 0 at load ratio 0.3, 100 at load ratio 1.5+
    const cpuScore = Math.min(100, Math.max(0,
      ((loadRatio - 0.3) / 1.2) * 100
    ));

    // Memory score: 0 at 50% usage, 100 at 95% usage
    const memScore = Math.min(100, Math.max(0,
      ((memUsedRatio - 0.5) / 0.45) * 100
    ));

    // Combined: CPU weighted more (subprocess spawning is CPU-bound)
    const score = Math.round(cpuScore * 0.6 + memScore * 0.4);

    this.metrics = {
      loadAvg1: Math.round(loadAvg1 * 100) / 100,
      loadRatio: Math.round(loadRatio * 100) / 100,
      memUsedRatio: Math.round(memUsedRatio * 100) / 100,
      freeMem,
      totalMem,
      cpuScore: Math.round(cpuScore),
      memScore: Math.round(memScore),
      coreCount: this.coreCount,
    };

    const previousLevel = this.currentLevel;
    this.currentScore = score;
    this.currentLevel = this._scoreToLevel(score);

    if (this.currentLevel !== previousLevel) {
      console.log(`[Health] ${previousLevel} -> ${this.currentLevel} (score: ${score}, cpu: ${this.metrics.cpuScore}, mem: ${this.metrics.memScore})`);
      this.emit('level-change', {
        from: previousLevel,
        to: this.currentLevel,
        score,
        metrics: this.metrics,
      });
    }
  }

  /**
   * Hysteresis-based level transitions.
   * Requires crossing the threshold by 5 points to change level,
   * preventing rapid flapping.
   */
  _scoreToLevel(score) {
    if (this.currentLevel === 'green' && score >= 40) return 'yellow';
    if (this.currentLevel === 'yellow' && score < 35) return 'green';
    if (this.currentLevel === 'yellow' && score >= 70) return 'red';
    if (this.currentLevel === 'red' && score < 65) return 'yellow';
    return this.currentLevel;
  }

  getStatus() {
    return {
      score: this.currentScore,
      level: this.currentLevel,
      metrics: this.metrics,
      timestamp: Date.now(),
    };
  }
}

module.exports = { SystemHealthMonitor };
