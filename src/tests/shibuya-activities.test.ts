import { beforeAll, expect, it } from 'vitest';
import { DEFAULT_CONFIG, FIXED_DT, type CrowdPreset, type SignalState } from '../types';
import { AgentData } from '../simulation/AgentData';
import { ShibuyaActivities, ActivityRole } from '../simulation/ShibuyaActivities';
import { Simulation } from '../simulation/Simulation';
import { SpatialGrid } from '../simulation/SpatialGrid';
import { Navigation } from '../simulation/Navigation';
import { syntheticShibuya } from './fixtures/synthetic-shibuya';

let initial: Simulation;
beforeAll(() => { initial = new Simulation({ ...DEFAULT_CONFIG, crowdModel: 'baseline', crowdPreset: 'none' }); });
const green: SignalState = { mode: 'auto', pedestrian: 'green', eastWest: 'red', northSouth: 'red', remaining: 30, crossing: 0, waiting: 0 };

function cast(preset: CrowdPreset, seed = 42) {
  const source = initial.agents, a = new AgentData(source.count);
  a.current.x.set(source.current.x); a.current.z.set(source.current.z);
  a.current.vx.set(source.current.vx); a.current.vz.set(source.current.vz);
  a.radius.set(source.radius); a.targetId.set(source.targetId);
  a.preferredSpeed.set(source.preferredSpeed); a.speedFactor.set(source.speedFactor);
  const grid = new SpatialGrid(initial.scenario.bounds, a.count); grid.rebuild(a.current.x, a.current.z, a.count);
  return { a, activities: new ShibuyaActivities(preset, seed, a, initial.navigation, grid) };
}

function middle(a: AgentData, id: number) {
  const m = initial.scenario.scramble!.crosswalks[4];
  a.current.x[id] = (m.from.x + m.to.x) / 2; a.current.z[id] = (m.from.z + m.to.z) / 2;
}

function companions(count: 2 | 4) {
  const a = new AgentData(count + 1), nav = new Navigation(syntheticShibuya);
  a.radius.fill(0.25); a.preferredSpeed.fill(1.35);
  for (let i = 0; i < a.count; i++) {
    a.current.x[i] = 26 + (i % 2) * 0.72;
    a.current.z[i] = 26 + Math.floor(i / 2) * 0.72;
    // The last passerby stays in the southeast. The companions all take the diagonal northwest.
    a.targetId[i] = i === count ? 3 : 0;
  }
  const grid = new SpatialGrid(syntheticShibuya.bounds, a.count);
  grid.rebuild(a.current.x, a.current.z, a.count);
  const activities = new ShibuyaActivities('group', 0, a, nav, grid);
  expect(activities.subjects).toHaveLength(count);
  return { a, activities };
}

it('casts a reproducible showcase from the original trips and mixes all three activities sparingly', () => {
  const { activities, a } = cast('mixed');
  expect(activities.subjects).toEqual(cast('mixed').activities.subjects);
  expect(a.current.x).toEqual(initial.agents.current.x); expect(a.targetId).toEqual(initial.agents.targetId);
  const roles = activities.subjects.map(id => activities.role[id]);
  expect(roles.filter(role => role === ActivityRole.Runner)).toHaveLength(1);
  expect(roles.filter(role => role === ActivityRole.Photographer)).toHaveLength(1);
  expect(roles.filter(role => role === ActivityRole.Companion).length).toBeGreaterThanOrEqual(2);
  expect(roles.filter(role => role === ActivityRole.Companion).length).toBeLessThanOrEqual(4);
  expect(cast('none').activities.subjectId).toBe(-1);
});

it('selects the head of an existing line for the solo photograph while the runner takes the nearest approach', () => {
  const a = new AgentData(3), grid = new SpatialGrid(initial.scenario.bounds, a.count);
  const m = initial.scenario.scramble!.crosswalks[4], dx = m.to.x - m.from.x, dz = m.to.z - m.from.z;
  const length = Math.hypot(dx, dz), ux = dx / length, uz = dz / length;
  const target = initial.scenario.portals!.findIndex(p => p.id === 'north-shop');
  for (const [id, along, across] of [[0, 1, 3], [1, 4, 0], [2, 6, 0]]) {
    a.current.x[id] = m.to.x + along * ux + across * uz;
    a.current.z[id] = m.to.z + along * uz - across * ux;
    a.targetId[id] = target;
  }
  grid.rebuild(a.current.x, a.current.z, a.count);
  expect(new ShibuyaActivities('selfie', 42, a, initial.navigation, grid).subjectId).toBe(1);
  expect(new ShibuyaActivities('runner', 42, a, initial.navigation, grid).subjectId).toBe(0);
});

it('gives the runner a distinct physical pace only while crossing on green', () => {
  const { a, activities } = cast('runner'), id = activities.subjectId;
  middle(a, id); activities.beginStep(FIXED_DT, { ...green, pedestrian: 'red' });
  expect(activities.counts.runnerStarts).toBe(0);
  activities.beginStep(FIXED_DT, green);
  expect(a.preferredSpeed[id] * activities.guide(id, { x: 0, z: 1 }, false)).toBeCloseTo(3, 0);
  expect(activities.counts.runnerStarts).toBe(1);
  activities.beginStep(FIXED_DT, { ...green, pedestrian: 'flashingGreen' });
  expect(activities.pace[id]).toBe(1);
});

it('reserves a full stationary photo hold, then eases out of the arm pose and resumes the same trip', () => {
  const { a, activities } = cast('selfie'), id = activities.subjectId, target = a.targetId[id];
  middle(a, id); activities.beginStep(FIXED_DT, { ...green, remaining: 1 });
  expect(activities.counts.selfieStarts).toBe(0);
  a.current.vx[id] = 1; activities.beginStep(FIXED_DT, green);
  expect(activities.stationary[id]).toBe(1); expect(activities.pace[id]).toBe(0); expect(activities.selfiePose[id]).toBe(0);
  a.current.vx[id] = a.current.vz[id] = 0;
  for (let i = 0; i < 60; i++) activities.beginStep(FIXED_DT, green);
  expect(activities.stationary[id]).toBe(1); expect(activities.selfiePose[id]).toBe(1);
  for (let i = 0; i < 40; i++) activities.beginStep(FIXED_DT, green);
  expect(activities.stationary[id]).toBe(0); expect(activities.pace[id]).toBe(1);
  expect(activities.selfiePose[id]).toBe(0); expect(a.targetId[id]).toBe(target);
  expect(activities.counts.selfieStarts).toBe(1); expect(activities.subjectId).toBe(-1);
});

it('interrupts a photograph on flashing green and resets life-bound intent', () => {
  const { a, activities } = cast('selfie'), id = activities.subjectId;
  middle(a, id); a.current.vx[id] = a.current.vz[id] = 0;
  for (let i = 0; i < 30; i++) activities.beginStep(FIXED_DT, green);
  activities.beginStep(FIXED_DT, { ...green, pedestrian: 'flashingGreen' });
  expect(activities.stationary[id]).toBe(0); expect(activities.pace[id]).toBe(1);
  activities.reset(id); expect(activities.selfiePose[id]).toBe(0); expect(activities.role[id]).toBe(ActivityRole.Walker);
});

it('binds group slots to nearby people sharing a trip and limits alignment to real companions', () => {
  const { a, activities } = companions(2), ids = activities.subjects, id = ids[0];
  for (const other of ids) {
    expect(a.targetId[other]).toBe(a.targetId[id]); expect(activities.groupLeader[other]).toBe(id);
    expect(Math.hypot(a.current.x[id] - a.current.x[other], a.current.z[id] - a.current.z[other])).toBeLessThan(4);
  }
  expect(new Set(ids.map(i => activities.groupSlot[i])).size).toBe(ids.length);
  activities.beginStep(FIXED_DT, green);
  const route = { x: 0, z: 1 };
  expect(activities.guide(id, route, false)).toBe(1); expect(route).toEqual({ x: 0, z: 1 });
  activities.guide(id, route, true); expect(route.x).not.toBe(0);
  const passerby = activities.role.indexOf(ActivityRole.Walker), otherRoute = { x: 0, z: 1 };
  expect(activities.guide(passerby, otherRoute, true)).toBe(1); expect(otherRoute).toEqual({ x: 0, z: 1 });
  activities.reset(id);
  for (const member of ids) {
    expect(activities.groupLeader[member]).toBe(-1); expect(activities.groupTrackKey[member]).toBe(-1);
  }
});

it('makes room at the far curb before slowing a split group and bounds the reunion wait', () => {
  const { a, activities } = cast('group'), [id, other] = activities.subjects;
  const m = initial.scenario.scramble!.crosswalks[4];
  const dx = m.to.x - m.from.x, dz = m.to.z - m.from.z, length = Math.hypot(dx, dz);
  const red: SignalState = { ...green, pedestrian: 'red' };
  a.current.x[id] = m.from.x - 6 * dx / length; a.current.z[id] = m.from.z - 6 * dz / length;
  middle(a, other); activities.beginStep(FIXED_DT, red);
  const dir = { x: -dx / length, z: -dz / length };
  expect(activities.guide(id, dir, true)).toBeLessThan(0.3);
  expect(activities.guide(other, dir, true)).toBe(1);
  for (let i = 0; i < 280; i++) activities.beginStep(FIXED_DT, red);
  expect(activities.guide(id, dir, true)).toBe(1);
});

it('frames new participants on later mixed greens after the initial lives leave', () => {
  const { a, activities } = cast('mixed');
  activities.beginStep(FIXED_DT, green);
  for (const id of activities.subjects) { activities.reset(id); a.portalStage[id] = 1; }
  expect(activities.subjectId).toBe(-1);
  activities.beginStep(FIXED_DT, { ...green, pedestrian: 'red' }); activities.beginStep(FIXED_DT, green);
  expect(activities.subjectId).toBeGreaterThanOrEqual(0); expect(activities.subjects).not.toContain(activities.subjectId);
  const newKey = Math.max(...activities.groupTrackKey);
  expect(newKey).toBe(a.count);
  for (let id = 0; id < a.count; id++) {
    if (activities.groupTrackKey[id] === newKey) activities.reset(id);
  }
  activities.beginStep(FIXED_DT, { ...green, pedestrian: 'red' }); activities.beginStep(FIXED_DT, green);
  expect(Math.max(...activities.groupTrackKey)).toBe(newKey + 1);
});

it('keeps three companions travelling when the fourth member completes their trip first', () => {
  const { activities } = companions(4), [leader, ...others] = activities.subjects;
  expect(others).toHaveLength(3);
  expect(activities.groupTrackKey[leader]).toBe(leader);
  activities.reset(leader);
  expect(activities.groupLeader[leader]).toBe(-1); expect(activities.groupTrackKey[leader]).toBe(-1);
  const successor = activities.subjectId;
  expect(others).toContain(successor);
  for (const other of others) {
    expect(activities.groupLeader[other]).toBe(successor); expect(activities.groupTrackKey[other]).toBe(leader);
  }
});
