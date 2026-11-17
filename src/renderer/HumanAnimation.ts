/** Joint coordinates in metres. Kept alongside the mesh as the animation import boundary.
 * The initial implementation is procedural WGSL; clip data/skinning can replace it.
 */
export const HUMAN_JOINTS = {
  hip: 0.91,
  knee: 0.49,
  shoulder: 1.41,
  elbow: 1.09,
} as const;

export const ANIMATION_CLIPS = { idle: 0, walk: 1, run: 2 } as const;
