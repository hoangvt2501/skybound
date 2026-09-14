/**
 * Fixed-timestep accumulator with bounded catch-up and render interpolation.
 */
import { SIM_MAX_ACCUMULATED, SIM_MAX_STEPS_PER_FRAME, SIM_STEP } from './config';

export class FixedStepClock {
  readonly step: number;
  private maxAccumulated: number;
  private maxSteps: number;
  private accumulator = 0;
  /** Simulated time in seconds. */
  time = 0;
  /** Total steps performed. */
  steps = 0;
  /** Steps dropped due to catch-up limits. */
  dropped = 0;

  constructor(step = SIM_STEP, maxAccumulated = SIM_MAX_ACCUMULATED, maxSteps = SIM_MAX_STEPS_PER_FRAME) {
    this.step = step;
    this.maxAccumulated = maxAccumulated;
    this.maxSteps = maxSteps;
  }

  /**
   * Feed a frame delta (seconds). Returns the number of fixed steps to run.
   * Large deltas (tab resume) are clamped so the simulation never spirals.
   */
  advance(frameDt: number): number {
    if (!(frameDt > 0)) return 0;
    this.accumulator += frameDt;
    if (this.accumulator > this.maxAccumulated) {
      this.dropped += Math.floor((this.accumulator - this.maxAccumulated) / this.step);
      this.accumulator = this.maxAccumulated;
    }
    let n = Math.floor(this.accumulator / this.step);
    if (n > this.maxSteps) {
      this.dropped += n - this.maxSteps;
      n = this.maxSteps;
      this.accumulator = Math.min(this.accumulator, this.step * this.maxSteps + this.step * 0.999);
    }
    this.accumulator -= n * this.step;
    this.time += n * this.step;
    this.steps += n;
    return n;
  }

  /** Capture a fresh previous state before EACH step, including catch-up frames. */
  run(frameDt: number, beforeStep: () => void, simulate: () => void): number {
    const count = this.advance(frameDt);
    for (let i = 0; i < count; i++) { beforeStep(); simulate(); }
    return count;
  }

  /** Interpolation factor between the previous and current sim state. */
  get alpha(): number {
    return this.accumulator / this.step;
  }

  reset(): void {
    this.accumulator = 0;
  }
}
