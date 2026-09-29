// rAF cadence is an observed host interval, not GPU execution time. Keep it
// separate from the bounded step used by gameplay/physics/network updates.
export class FrameTiming {
  constructor({ now = 0, visible = true, warmupMS = 1000, pauseMS = 5000, maxStepMS = 100 } = {}) {
    for (const value of [now, warmupMS, pauseMS, maxStepMS]) {
      if (!Number.isFinite(value)) throw new RangeError('Frame timing requires finite values.');
    }
    if (warmupMS < 0 || pauseMS <= 0 || maxStepMS <= 0) throw new RangeError('Invalid frame timing interval.');
    this.warmupMS = warmupMS;
    this.pauseMS = pauseMS;
    this.maxStepMS = maxStepMS;
    this.reset(now, { visible });
  }

  reset(now, { visible = this.visible } = {}) {
    if (!Number.isFinite(now)) throw new RangeError('Frame timing requires a finite clock.');
    this.last = now;
    this.visible = visible;
    this.warmUntil = now + this.warmupMS;
    this.ignoreNext = true;
    this.pauseArmed = true;
    this.promptIntervals = 0;
  }

  sample(now, { visible = this.visible } = {}) {
    if (!Number.isFinite(now)) return { simulationSeconds: 0, measurementMS: null, qualitySeconds: null, reset: false };
    let reset = false;
    if (visible !== this.visible || now < this.last) {
      this.reset(now, { visible });
      reset = true;
    }
    const elapsedMS = now - this.last;
    if (!Number.isFinite(elapsedMS)) {
      this.reset(now, { visible });
      return { simulationSeconds: 0, measurementMS: null, qualitySeconds: null, reset: true };
    }
    this.last = now;
    const simulationSeconds = Math.min(this.maxStepMS, elapsedMS) / 1000;
    if (visible && elapsedMS >= this.pauseMS && this.pauseArmed) {
      // A suspend can occur without visibilitychange. Discard one wake gap,
      // not every slow frame: once disarmed, sustained low FPS remains genuine
      // quality evidence. Rearm only after prompt visible callbacks resume.
      this.reset(now, { visible });
      this.pauseArmed = false;
      reset = true;
    }
    if (visible && elapsedMS > 0 && elapsedMS < 250) {
      if (++this.promptIntervals >= 2) this.pauseArmed = true;
    } else this.promptIntervals = 0;
    const measurable = visible && elapsedMS > 0 && !this.ignoreNext;
    this.ignoreNext = false;
    return { simulationSeconds, measurementMS: measurable ? elapsedMS : null,
      qualitySeconds: measurable && now >= this.warmUntil ? elapsedMS / 1000 : null, reset };
  }
}
