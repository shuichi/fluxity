import { describe, expect, it } from 'vitest';
import { shibuya } from '../scenarios/shibuya';
import { AgentData } from '../simulation/AgentData';
import { DoorwayHeadway } from '../simulation/DoorwayHeadway';
import { Navigation } from '../simulation/Navigation';
import { Simulation } from '../simulation/Simulation';
import { SpatialGrid } from '../simulation/SpatialGrid';
import { DEFAULT_CONFIG, FIXED_DT } from '../types';

const portals = shibuya.portals!;
const shop = portals.findIndex(p => p.id === 'northwest-shop');
const navigation = new Navigation(shibuya);
const towardShop = { x: -1, z: 0 };

function queue(count = 2) {
  const agents = new AgentData(count);
  agents.targetId.fill(shop);
  agents.radius.fill(0.25);
  agents.current.x.set([-30.1, -31]);
  agents.current.z.fill(-26);
  agents.current.heading.fill(-Math.PI / 2);
  const grid = new SpatialGrid(shibuya.bounds, count);
  const headway = new DoorwayHeadway(agents, grid, navigation, portals);
  function velocity(id = 0, step = 0, direction = towardShop) {
    grid.rebuild(agents.current.x, agents.current.z, agents.count);
    const result = { ...direction };
    headway.limit(id, step, step * FIXED_DT, direction, result);
    return result;
  }
  return { agents, velocity };
}

describe('following distance on the shop sidewalk', () => {
  it('lets the closer walker proceed even when both have turned to face one another', () => {
    const { agents, velocity } = queue();
    agents.current.heading[1] = Math.PI / 2;
    expect(velocity()).toEqual({ x: 0, z: 0 });
    const towardFollower = { x: 1, z: 0 };
    expect(velocity(1, 5, towardFollower)).toEqual(towardFollower);
  });

  it('reacts to a stopped walker once a moving bystander clears the line of sight', () => {
    const { agents, velocity } = queue(3);
    agents.radius[2] = 0.16;
    agents.current.x[2] = -30.55;
    agents.current.vz[2] = 1;
    expect(velocity()).toEqual(towardShop);
    agents.current.z[2] += 1;
    expect(velocity(0, 6)).toEqual({ x: 0, z: 0 });
  });

  it('resumes when the leader walks on and the brief brake expires', () => {
    const { agents, velocity } = queue();
    expect(velocity()).toEqual({ x: 0, z: 0 });
    agents.current.vx[1] = -1;
    expect(velocity(0, 18)).toEqual(towardShop);
  });

  it.each([0, 1])('drops the previous hold when walker slot %i is reused', replaced => {
    const { agents, velocity } = queue();
    expect(velocity()).toEqual({ x: 0, z: 0 });
    agents.generation[replaced]++;
    agents.current.x[1] = -34;
    expect(velocity(0, 1)).toEqual(towardShop);
  });

  it('leaves through traffic free to pass the shop', () => {
    const { agents, velocity } = queue();
    agents.targetId[0] = portals.findIndex(p => p.kind === 'street');
    expect(velocity()).toEqual(towardShop);
  });

  it('keeps a shopper moving across the road when the leader stops at the curb', () => {
    const { agents, velocity } = queue();
    agents.current.x.fill(-30.1);
    agents.current.z.set([-11.95, -12.85]);
    agents.current.heading.fill(Math.PI);
    const clearCurb = { x: 0, z: -1 };
    expect(navigation.scramble!.isSidewalk(agents.current.x[0], agents.current.z[0])).toBe(false);
    expect(navigation.lineOfSight(-30.1, -11.95, -30.1, -12.85, 0.265)).toBe(true);
    expect(velocity(0, 0, clearCurb)).toEqual(clearCurb);
    agents.current.z[0] -= 1;
    agents.current.z[1] -= 1;
    expect(velocity(0, 6, clearCurb)).toEqual({ x: 0, z: 0 });
  });

  it('brakes before overlap in the simulation step and proceeds once the way is clear', () => {
    const scenario = { ...shibuya, spawnTargets: shibuya.spawnZones.map(() => shop) };
    let makingRoomAtCurb = false;
    const sim = new Simulation({ ...DEFAULT_CONFIG, count: 2, seed: 42, signalMode: 'pedestrian' }, {
      get yieldingAtCurb() { return makingRoomAtCurb; },
      compute(id, _agents, _grid, direction, _settings, result) {
        result.x = id === 0 && !makingRoomAtCurb ? direction.x : 0;
        result.z = id === 0 ? (makingRoomAtCurb ? 1 : direction.z) : 0;
      },
    }, scenario);
    const a = sim.agents, s = a.current;
    a.targetX.fill(-33); a.targetZ.fill(-26);
    s.x.set([-30.1, -31]); s.z.fill(-26);
    s.vx.fill(0); s.vz.fill(0); s.heading.fill(-Math.PI / 2);
    const start = s.x[0];
    for (let i = 0; i < 15; i++) sim.step();
    expect(start - a.current.x[0]).toBeLessThan(0.05);
    expect(a.current.x[0] - a.current.x[1]).toBeGreaterThan(a.radius[0] + a.radius[1]);
    // The queue is still stopped when local steering asks to give a crosser room.
    makingRoomAtCurb = true;
    const oldZ = a.current.z[0];
    for (let i = 0; i < 4; i++) sim.step();
    expect(a.current.z[0]).toBeGreaterThan(oldZ + 0.015);
    makingRoomAtCurb = false;
    a.current.z[1] -= 3;
    for (let i = 0; i < 30; i++) sim.step();
    expect(a.current.x[0]).toBeLessThan(start - 0.2);
  });
});
