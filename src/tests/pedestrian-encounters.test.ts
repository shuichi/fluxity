import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type Obstacle, type Scenario } from '../types';
import { AgentData } from '../simulation/AgentData';
import { EncounterState } from '../simulation/EncounterState';
import { Navigation } from '../simulation/Navigation';
import { SpatialGrid } from '../simulation/SpatialGrid';
import { Steering } from '../simulation/Steering';
import { syntheticShibuya } from './fixtures/synthetic-shibuya';

function wall(z: number): Obstacle {
  return { x: 0, z, width: 6, depth: 0.2, height: 2, kind: 'building' };
}

function crossing(obstacles: Obstacle[] = [], count = 2) {
  const scene: Scenario = {
    id: 'corridor', name: 'Two-way path', description: '', obstacles,
    bounds: { minX: -8, maxX: 8, minZ: -8, maxZ: 8 },
    spawnZones: [{ x: -5, z: 0, width: 2, depth: 2 }], targets: [{ x: 6, z: 0 }],
  };
  const a = new AgentData(count), e = new EncounterState(count, 42);
  const grid = new SpatialGrid(scene.bounds, count);
  const steer = new Steering(scene, undefined, undefined, e, new Navigation(scene));
  a.radius.fill(0.25); a.preferredSpeed.fill(1.35);
  a.current.x[1] = 1.8;
  a.current.vx.set([1.35, -1.35]); a.current.heading[0] = Math.PI / 2;
  const velocity = { x: 0, z: 0 };
  function decide(id = 0) {
    e.advance(id, 1 / 30); grid.rebuild(a.current.x, a.current.z, a.count);
    steer.compute(id, a, grid, { x: id ? -1 : 1, z: 0 }, DEFAULT_CONFIG, velocity);
    return velocity;
  }
  return { a, e, decide };
}

describe('pedestrian encounters', () => {
  it('gives an approaching crosser room at the curb even when their chosen landing is farther ahead', () => {
    const a = new AgentData(2), nav = new Navigation(syntheticShibuya);
    const grid = new SpatialGrid(syntheticShibuya.bounds, a.count);
    const clearing = new Uint8Array([1, 0]);
    const blocked = new Uint8Array(2);
    const exits = { clearing, blocked, waypointX: new Float32Array([-27, NaN]), waypointZ: new Float32Array([52, NaN]) };
    const steering = new Steering(syntheticShibuya, undefined, undefined, undefined, nav, exits);
    a.radius.fill(0.25); a.preferredSpeed.fill(1.35);
    a.current.x.fill(-27); a.current.z.set([17.4, 18.6]);
    grid.rebuild(a.current.x, a.current.z, a.count);

    const standing = { x: 0, z: 0 }, velocity = { x: 0, z: 0 };
    steering.compute(1, a, grid, standing, DEFAULT_CONFIG, velocity, 1, true);
    expect(Math.abs(velocity.x)).toBeGreaterThan(0.2);
    expect(velocity.z).toBeGreaterThan(0.2);
    clearing[0] = 0;
    steering.compute(1, a, grid, standing, DEFAULT_CONFIG, velocity, 1, true);
    expect(velocity).toEqual(standing);
    // The second row normally holds its place; a persistent blockage prompts it to make more room.
    clearing[0] = 1;
    a.current.x[1] += 1; a.current.z[1] = 19.15;
    grid.rebuild(a.current.x, a.current.z, a.count);
    steering.compute(1, a, grid, standing, DEFAULT_CONFIG, velocity, 1, true);
    expect(velocity).toEqual(standing);
    blocked[0] = 1;
    steering.compute(1, a, grid, standing, DEFAULT_CONFIG, velocity, 1, true);
    expect(velocity.z).toBeGreaterThan(0.2);
  });

  it('chooses reciprocal passing sides and holds them through small position changes', () => {
    const { a, e, decide } = crossing();
    decide(0); decide(1);
    expect(e.passSide[0]).toBe(1); expect(e.passSide[1]).toBe(1);
    expect(e.gazeTarget[0]).toBe(1);
    for (let step = 0; step < 12; step++) {
      a.current.z[1] = step % 2 ? -0.08 : 0.08;
      decide();
      expect(e.passSide[0]).toBe(1);
    }
    a.current.x[1] = -5;
    for (let step = 0; step < 20; step++) decide();
    expect(e.passSide[0]).toBe(0);
  });

  it('signals a future gap before the body moves, and takes imminent evasive action immediately', () => {
    const early = crossing(), urgent = crossing();
    early.a.current.x[1] = 2.2; early.a.generation[1] = 8;
    expect(Math.abs(early.decide().z)).toBeLessThan(0.001);
    expect(early.e.passSide[0]).toBe(1); expect(early.e.gazeLife[0]).toBe(8);
    expect(early.decide().z).toBeLessThan(-0.1);
    urgent.a.current.x[1] = 1.2;
    expect(urgent.decide().z).toBeLessThan(-0.3);
  });

  it('uses the open gap against a wall, and brakes when both gaps are closed', () => {
    const openLeft = crossing([wall(-0.6)]);
    expect(openLeft.decide().z).toBeGreaterThan(0);
    expect(openLeft.e.passSide[0]).toBe(-1);
    const narrow = crossing([wall(-0.6), wall(0.6)]);
    expect(narrow.decide().x).toBeLessThan(0.8);
    expect(narrow.e.passSide[0]).toBe(0);
    expect(narrow.e.yielding[0]).toBe(1);
  });

  it('reacts once to closing physical contact and rearms after fully leaving a cluster', () => {
    const { a, e, decide } = crossing([], 3);
    a.current.x.set([0, 0.35, -0.25]); a.current.z.set([0, -0.22, 0.30]);
    a.current.vx.fill(0);
    decide(); expect(e.contactEvents).toBe(0);
    a.current.vx[0] = 1.35;
    decide(); expect(e.contactEvents).toBe(1); expect(e.lean[0]).toBeLessThan(0);
    const onset = Math.abs(e.lean[0]);
    for (let i = 0; i < 30; i++) {
      a.current.x[1] = i % 2 ? 0.36 : 1.4; // A second shoulder stays in contact.
      decide();
    }
    expect(e.contactEvents).toBe(1); expect(Math.abs(e.lean[0])).toBeLessThan(onset * 0.05);
    a.current.x.set([0, 3, -3]);
    for (let i = 0; i < 12; i++) decide();
    a.current.x[1] = 0.35; decide();
    expect(e.contactEvents).toBe(2);
  });

  it('scales the contact recoil with relative speed, clears it on replacement, and varies by generation', () => {
    const slow = crossing(), fast = crossing();
    for (const { a } of [slow, fast]) { a.current.x[1] = 0.45; a.current.vx[1] = 0; }
    slow.a.current.vx[0] = 0.4; slow.decide(); fast.decide();
    expect(Math.abs(fast.e.lean[0])).toBeGreaterThan(Math.abs(slow.e.lean[0]));
    const horizon = fast.e.horizon[0];
    fast.e.reset(0, 1);
    expect(fast.e.lean[0]).toBe(0); expect(fast.e.passSide[0]).toBe(0);
    expect(fast.e.horizon[0]).not.toBe(horizon);
    slow.e.reset(0, 1);
    expect(fast.e.horizon[0]).toBe(slow.e.horizon[0]);
  });
});
