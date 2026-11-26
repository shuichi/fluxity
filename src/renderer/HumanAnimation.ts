// Rounded, standing dimensions in metres from the AIST 1991–92 young-adult
// pooled medians (B1, B2, B19, D2). Shoulder breadth includes both deltoids.
export const HUMAN_HEIGHT = 1.65;
export const HUMAN_EYE_HEIGHT = 1.535;
export const HUMAN_SHOULDER_BREADTH = 0.433;

// Used as vertex-pipeline overrides so mesh segments and pivots share coordinates.
export const HUMAN_JOINTS = {
  hip: 0.844, hipX: 0.083,
  knee: 0.424,
  ankle: 0.067,
  shoulder: 1.33, shoulderX: 0.174,
  elbow: 1.026,
  neck: 1.42,
} as const;

export const HUMAN_GAIT = {
  walkStride: 0.53, runExtraStride: 0.31,
  leanAngle: 0.21, bobHeight: 0.012, runTilt: 0.09,
} as const;

export const ANIMATION_CLIPS = { idle: 0, walk: 1, run: 2 } as const;
