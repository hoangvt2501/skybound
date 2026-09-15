/**
 * Central tuning for SKYBOUND. Everything that designers might want to tweak
 * lives here so gameplay feel, world scale and streaming budgets are adjusted
 * in one place.
 */

/** Bump whenever terrain generation changes; older saves are migrated (position kept, discoveries reset). */
export const WORLD_GEN_VERSION = 5;
export const SAVE_VERSION = 1;
export const SHOWCASE_SEED = 1207;

/** Curated region is 32 km x 32 km centered on the origin. */
export const REGION_HALF_SIZE = 16000;
export const SEA_LEVEL = 0;

export const CHUNK_SIZE = 512;
/** Vertex spacing (m) per LOD level. LOD0 is nearest. */
export const LOD_SPACING = [4, 8, 16, 32] as const;
/** Chebyshev chunk-ring at which each LOD begins. */
export const LOD_RINGS = [0, 2, 4, 7] as const;
/** Vegetation is generated for chunks up to this LOD (inclusive); LOD 2 renders impostors. */
export const VEGETATION_MAX_LOD = 2;
/** Full tree geometry up to this LOD (rings 0-1, ~1 km); beyond it impostors are used. */
export const VEGETATION_FULL_LOD = 0;

/** Far tier: coarse shell tiles beyond the detailed chunk radius. */
export const FAR_TILE_SIZE = 4096;
export const FAR_TILE_SEGMENTS = 64;
export const FAR_TILE_Y_OFFSET = -14;

export type QualityPreset = 'low' | 'medium' | 'high';

export interface QualitySettings {
  /** Detailed chunk radius in chunks (Chebyshev). */
  chunkRadius: number;
  /** Far shell radius in far tiles (0 disables). */
  farRadius: number;
  /**
   * Near-field ground cover density multiplier (0 disables). Trees are
   * placed at a fixed density on every preset so collision is identical.
   */
  groundCover: number;
  shadows: boolean;
  clouds: boolean;
  /** Maximum cloud puff billboards. */
  cloudPuffs: number;
  maxPixelRatio: number;
  /** Fog visibility distance in meters (fog reaches ~full opacity here). */
  fogFar: number;
  /** Max terrain generation jobs in flight. */
  maxJobs: number;
}

export const QUALITY_PRESETS: Record<QualityPreset, QualitySettings> = {
  // The frame is fill-rate bound on integrated GPUs (see docs/VERIFICATION.md): geometric
  // detail is cheap while the adaptive render scale keeps every frame inside one refresh.
  // Pixel-ratio caps are therefore modest; the controller raises the scale when there is room.
  low: {
    chunkRadius: 5,
    farRadius: 2,
    groundCover: 0.25,
    shadows: false,
    clouds: true,
    cloudPuffs: 360,
    maxPixelRatio: 1,
    fogFar: 4200,
    maxJobs: 2,
  },
  medium: {
    chunkRadius: 8,
    farRadius: 3,
    groundCover: 0.85,
    shadows: true,
    clouds: true,
    cloudPuffs: 600,
    maxPixelRatio: 1.25,
    fogFar: 6200,
    maxJobs: 3,
  },
  high: {
    chunkRadius: 10,
    farRadius: 4,
    groundCover: 1,
    shadows: true,
    clouds: true,
    cloudPuffs: 900,
    maxPixelRatio: 1.5,
    fogFar: 8600,
    maxJobs: 4,
  },
};

/** Fixed simulation step and catch-up limits. */
export const SIM_STEP = 1 / 60;
export const SIM_MAX_STEPS_PER_FRAME = 6;
export const SIM_MAX_ACCUMULATED = 0.25;

/** Arcade flight tuning. Units are meters, seconds and radians. */
export const FLIGHT = {
  cruiseSpeed: 34,
  minSpeed: 14,
  maxSpeed: 58,
  boostMaxSpeed: 82,
  boostAccel: 26,
  flapAccel: 12,
  flapLift: 7.5,
  /** Speed regained per second toward cruise when below it. */
  accelToCruise: 8,
  /** Fraction of excess speed shed per second. */
  drag: 0.55,
  gravityGain: 9.0,
  climbSpeedCost: 6.5,
  maxPitch: 0.62,
  minPitch: -0.85,
  glidePitch: -0.045,
  pitchRate: 1.9,
  pitchReturnRate: 1.1,
  /** Full-stick turn rate at cruise (rad/s), scaled by the species' agility. Was 1.35: too twitchy with a mouse hand on A/D. */
  maxTurnRate: 1.05,
  turnResponse: 2.6,
  /** Bank at full turn (rad); 45 degrees reads as a committed turn without the horizon tipping past comfort. Was 1.05 (60 degrees). */
  maxBank: 0.78,
  bankResponse: 3.4,
  flapPitchBoost: 0.28,
  boostCapacity: 100,
  boostDrain: 34,
  boostRecovery: 16,
  boostRecoveryDelay: 1.2,
  boostMinToStart: 15,
  groundClearance: 1.6,
  impactSpeedFactor: 0.45,
  impactCooldown: 1.0,
  maxAltitude: 2600,
  /** Sim substep length for swept collision (m). */
  sweepStep: 6,
} as const;

export const CAMERA = {
  chase: { distance: 16, height: 5, lookAhead: 14, fov: 62 },
  cinematic: { distance: 34, height: 10, lookAhead: 32, fov: 50 },
  minDistance: 6,
  maxDistance: 45,
  positionSmoothing: 6,
  lookSmoothing: 8,
  rollFollow: 0.28,
  minClearance: 2.2,
  orbitReturnDelay: 1.6,
  orbitReturnRate: 2.4,
  /** Free-look drag: radians of orbit per pixel at sensitivity 1 (0.2 and 0.17 degrees; were 0.006 / 0.005 rad). */
  mouseYawPerPixel: 0.0035,
  mousePitchPerPixel: 0.003,
} as const;

export const AUTOPILOT = {
  lookAheadNear: 480,
  lookAheadFar: 2000,
  cruiseAboveGround: 95,
  minAboveGround: 40,
  turnGain: 0.9,
  /** Raised with the slower manual turn rate so the autopilot keeps the same authority (~1.0 rad/s). */
  maxTurnInput: 0.95,
  arriveRadius: 130,
  loiterRadius: 210,
  wanderPeriod: 47,
} as const;

export const WAYPOINT_ARRIVE_RADIUS = 110;
export const LANDMARK_DISCOVERY_RADIUS = 260;
export const EXPLORE_CELL_SIZE = 500;

export const DAY_LENGTH_SECONDS = 720;

export const STORAGE_KEYS = {
  save: 'skybound.save.v1',
  settings: 'skybound.settings.v1',
} as const;
