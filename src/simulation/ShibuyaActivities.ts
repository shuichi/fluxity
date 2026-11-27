import type { CrowdPreset, SignalState } from '../types';
import { Random } from '../math/random';
import type { AgentData } from './AgentData';
import type { Direction, Navigation } from './Navigation';
import type { SpatialGrid } from './SpatialGrid';

export enum ActivityRole { Walker, Runner, Photographer, Companion }
const enum Action { Ready, Running, Braking, Holding, Finished }
type Mark = { x: number; z: number; ux: number; uz: number; width: number; length: number };
type Candidate = { id: number; sign: number; score: number };
interface Party { members: number[]; mark: Mark; sign: number; openWidth: number; regroupSeconds: number }
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/** Cast activities on existing compatible trips. This owns no clock, trip or appearance randomness shared with the crowd. */
export class ShibuyaActivities {
  readonly role: Uint8Array;
  readonly pace: Float32Array;
  readonly selfiePose: Float32Array;
  readonly stationary: Uint8Array;
  readonly groupLeader: Int32Array;
  /** Shared identity for zebra track choice, including after a leader finishes their trip. */
  readonly groupTrackKey: Int32Array;
  readonly groupSlot: Float32Array;
  readonly subjects: number[] = [];
  readonly counts = { runnerStarts: 0, selfieStarts: 0, groupStarts: 0 };
  /** Frame an ongoing action first, then a companion or someone approaching their cue. */
  get subjectId(): number {
    let next = -1, runner = -1;
    for (const id of this.performers) {
      if (this.agents.portalStage[id] || this.agents.opacity[id] < 0.5) continue;
      if (this.action[id] === Action.Braking || this.action[id] === Action.Holding) return id;
      if (this.action[id] === Action.Running) runner = id;
      if (this.action[id] === Action.Ready && next < 0) next = id;
    }
    if (runner >= 0) return runner;
    for (const [leader, party] of this.groups) {
      if (!this.agents.portalStage[leader] && this.agents.opacity[leader] >= 0.5) return leader;
      const visible = party.members.find(id => !this.agents.portalStage[id] && this.agents.opacity[id] >= 0.5);
      if (visible !== undefined) return visible;
    }
    return next;
  }
  private readonly marks: Mark[];
  private readonly action: Uint8Array;
  private readonly remaining: Float32Array;
  private readonly duration: Float32Array;
  private readonly runSpeed: Float32Array;
  private readonly travelSign: Int8Array;
  private readonly soloMark: (Mark | undefined)[];
  private readonly performers = new Set<number>();
  private readonly groups = new Map<number, Party>();
  private nextGroupKey: number;
  private readonly random: Random;
  private green = false;
  private castIn = 42;

  constructor(private readonly preset: CrowdPreset, seed: number, private readonly agents: AgentData,
    private readonly nav: Navigation, private readonly grid: SpatialGrid) {
    const n = agents.count;
    this.nextGroupKey = n;
    this.random = new Random(seed ^ 0x41ad992d);
    this.role = new Uint8Array(n); this.action = new Uint8Array(n); this.stationary = new Uint8Array(n);
    this.pace = new Float32Array(n).fill(1); this.selfiePose = new Float32Array(n);
    this.remaining = new Float32Array(n); this.duration = new Float32Array(n); this.runSpeed = new Float32Array(n);
    this.travelSign = new Int8Array(n);
    this.groupLeader = new Int32Array(n).fill(-1); this.groupTrackKey = new Int32Array(n).fill(-1);
    this.groupSlot = new Float32Array(n); this.soloMark = new Array(n);
    this.marks = (nav.scenario.scramble?.crosswalks ?? []).flatMap(({ from, to, width }) => {
      const dx = to.x - from.x, dz = to.z - from.z, length = Math.hypot(dx, dz);
      return length > 1 && width >= 1 ? [{ x: from.x, z: from.z, ux: dx / length, uz: dz / length, width, length }] : [];
    }).sort((a, b) => b.length - a.length);
    if (nav.scenario.id === 'shibuya' && preset !== 'none') this.cast(true);
  }

  /** The trip field itself determines whether the person will pass the middle of this zebra. */
  private candidates(mark: Mark): Candidate[] {
    const a = this.agents, s = a.current, nav = this.nav;
    const people: Candidate[] = [];
    const maxSteps = Math.ceil((mark.length / 2 + 22) * 2 / nav.cellSize);
    for (let id = 0; id < a.count; id++) {
      if (this.role[id] || a.portalStage[id] || a.opacity[id] < 0.99) continue;
      const dx = s.x[id] - mark.x, dz = s.z[id] - mark.z;
      const along = dx * mark.ux + dz * mark.uz, side = dx * mark.uz - dz * mark.ux;
      const entryDistance = Math.hypot(Math.min(Math.abs(along), Math.abs(mark.length - along)), side);
      if (entryDistance > 19) continue;
      const field = nav.fields[a.targetId[id]];
      let cell = nav.cellAt(s.x[id], s.z[id]);
      for (let step = 0; step < maxSteps; step++) {
        const vx = Math.sign(field.x[cell]), vz = Math.sign(field.z[cell]);
        if (!vx && !vz) break;
        const x = nav.scenario.bounds.minX + (cell % nav.columns + 0.5) * nav.cellSize - mark.x;
        const z = nav.scenario.bounds.minZ + (Math.floor(cell / nav.columns) + 0.5) * nav.cellSize - mark.z;
        if (Math.abs(x * mark.ux + z * mark.uz - mark.length * 0.5) < nav.cellSize &&
          Math.abs(x * mark.uz - z * mark.ux) < mark.width * 0.5) {
          const sign = Math.sign(vx * mark.ux + vz * mark.uz);
          if (sign && (along - mark.length / 2) * sign < 0) {
            people.push({ id, sign, score: entryDistance + this.random.next() * 0.65 });
          }
          break;
        }
        cell += vx + vz * nav.columns;
      }
    }
    return people.sort((a, b) => a.score - b.score);
  }

  private cast(first: boolean): void {
    // In mixed scenes each green receives a handful of events; a held green can introduce later trips too.
    let runner = this.preset === 'runner' || this.preset === 'mixed';
    let selfie = this.preset === 'selfie' || this.preset === 'mixed';
    let group = this.preset === 'group' || (this.preset === 'mixed' && this.groups.size < 4);
    for (const mark of this.marks) {
      const people = this.candidates(mark);
      if (group && this.castParty(people, mark, first)) group = false;
      // The solo demonstration uses a real following stream so a short stop is visible to its neighbours.
      const solos = this.preset === 'selfie' && people.length ? [this.photographer(people, mark)] : people;
      for (const c of solos) {
        if (!runner && !selfie) break;
        if (this.role[c.id]) continue;
        const isRunner = runner;
        this.role[c.id] = isRunner ? ActivityRole.Runner : ActivityRole.Photographer;
        this.soloMark[c.id] = mark; this.travelSign[c.id] = c.sign; this.action[c.id] = Action.Ready;
        if (isRunner) this.runSpeed[c.id] = this.random.range(2.85, 3.12);
        else this.duration[c.id] = this.random.range(2.15, 2.65);
        this.performers.add(c.id);
        if (first) this.subjects.push(c.id);
        if (isRunner) runner = false; else selfie = false;
      }
      if (!runner && !selfie && !group) break;
    }
  }

  private photographer(people: Candidate[], mark: Mark): Candidate {
    const nearbyTrips = new Map(people.map(p => [p.id, p])), s = this.agents.current;
    let choice = people[0], best = Infinity;
    for (const person of people) {
      for (const follower of this.neighborsOnRoute(person, nearbyTrips, 6)) {
        const dx = s.x[person.id] - s.x[follower.id], dz = s.z[person.id] - s.z[follower.id];
        const ahead = (dx * mark.ux + dz * mark.uz) * person.sign, side = dx * mark.uz - dz * mark.ux;
        if (ahead < 0.2 || Math.abs(side) >= 4) continue;
        // Prefer a walker roughly two metres ahead in the same file. Preserve each person's trip and pace.
        const error = side * side / 3 + (ahead - 2) ** 2 / 8;
        if (error < best && this.nav.lineOfSight(s.x[person.id], s.z[person.id], s.x[follower.id], s.z[follower.id], 0.15)) {
          choice = person; best = error;
        }
      }
    }
    return choice;
  }

  private castParty(people: Candidate[], mark: Mark, first: boolean): boolean {
    const nearbyTrips = new Map(people.map(p => [p.id, p]));
    const size = 2 + this.random.int(3);
    let leader: Candidate | undefined, peers: Candidate[] = [];
    for (const person of people) {
      const a = this.agents, s = a.current, id = person.id;
      const compatible = this.neighborsOnRoute(person, nearbyTrips, 4).filter(p => a.targetId[p.id] === a.targetId[id]
        && this.nav.lineOfSight(s.x[id], s.z[id], s.x[p.id], s.z[p.id], 0.15));
      if (compatible.length > peers.length) { leader = person; peers = compatible; }
      if (peers.length >= size - 1) break;
    }
    if (!leader) return false;
    const s = this.agents.current, id = leader.id, sign = leader.sign;
    const distance = (other: number) => Math.hypot(s.x[id] - s.x[other], s.z[id] - s.z[other]);
    peers.sort((a, b) => distance(a.id) - distance(b.id));
    const members = [id, ...peers.slice(0, size - 1).map(p => p.id)];
    const key = first ? id : this.nextGroupKey++;
    const right = (member: number) => sign * (s.x[member] * mark.uz - s.z[member] * mark.ux);
    members.sort((i, j) => right(i) - right(j));
    for (let rank = 0; rank < members.length; rank++) {
      const member = members[rank]; this.role[member] = ActivityRole.Companion;
      this.groupTrackKey[member] = key;
      this.groupLeader[member] = id; this.groupSlot[member] = (rank - (members.length - 1) / 2) * 0.84;
    }
    this.groups.set(id, { members, mark, sign, openWidth: 1, regroupSeconds: 0 });
    if (first) this.subjects.push(id, ...members.filter(member => member !== id));
    this.counts.groupStarts++;
    return true;
  }

  private neighborsOnRoute(person: Candidate, trips: Map<number, Candidate>, radius: number): Candidate[] {
    const s = this.agents.current, g = this.grid, id = person.id;
    const x = s.x[id], z = s.z[id], peers: Candidate[] = [];
    const lo = g.cellAt(x - radius, z - radius), hi = g.cellAt(x + radius, z + radius);
    for (let row = Math.floor(lo / g.columns); row <= Math.floor(hi / g.columns); row++) {
      for (let col = lo % g.columns; col <= hi % g.columns; col++) {
        const cell = row * g.columns + col;
        for (let index = g.offsets[cell]; index < g.offsets[cell + 1]; index++) {
          const other = g.indices[index];
          if (other === id) continue;
          const trip = trips.get(other);
          if (trip?.sign === person.sign && Math.hypot(x - s.x[other], z - s.z[other]) < radius) peers.push(trip);
        }
      }
    }
    return peers;
  }

  beginStep(dt: number, signal: SignalState | undefined): void {
    const wasGreen = this.green;
    this.green = signal?.pedestrian === 'green';
    this.castIn -= dt;
    if (this.preset === 'mixed' && this.green && this.nav.scenario.id === 'shibuya' && this.castIn <= 0) {
      this.cast(false); this.castIn = 42;
    } else if (wasGreen && !this.green) this.castIn = 0;
    for (const id of this.performers) this.advanceSolo(id, dt, signal?.remaining ?? Infinity);
    for (const party of this.groups.values()) {
      const a = this.agents, s = a.current, m = party.mark;
      let density = 0, ahead = false, behind = false, allLanded = true;
      for (const id of party.members) {
        density += this.grid.counts[this.grid.cells[id]];
        const progress = ((s.x[id] - m.x) * m.ux + (s.z[id] - m.z) * m.uz - m.length / 2) * party.sign;
        ahead ||= progress > m.length / 2 + 2;
        behind ||= progress < m.length / 2 - 3;
        allLanded &&= progress > m.length / 2 - 1;
      }
      if (allLanded) party.regroupSeconds = 0;
      else if (party.regroupSeconds > 0 || (!this.green && ahead && behind)) party.regroupSeconds += dt;
      const openWidth = clamp(1.15 - 0.09 * density / party.members.length, 0.26, 1);
      party.openWidth += (openWidth - party.openWidth) * Math.min(1, dt * 1.8);
    }
  }

  private advanceSolo(id: number, dt: number, greenRemaining: number): void {
    const a = this.agents, s = a.current, m = this.soloMark[id]!;
    const dx = s.x[id] - m.x, dz = s.z[id] - m.z, sign = this.travelSign[id];
    const along = dx * m.ux + dz * m.uz, progress = sign > 0 ? along : m.length - along;
    const side = Math.abs(dx * m.uz - dz * m.ux), stage = this.action[id];
    const runner = this.role[id] === ActivityRole.Runner;
    const inactive = a.portalStage[id] !== 0 || !this.green || a.preferredSpeed[id] <= 0;
    if ((inactive && stage !== Action.Ready) || progress > m.length + 3) this.finish(id);
    if (!inactive && stage === Action.Ready && side < m.width / 2 - a.radius[id]) {
      if (runner && progress >= -2 && progress < 0.7 * m.length && greenRemaining > 3) {
        this.action[id] = Action.Running; this.counts.runnerStarts++;
      } else if (!runner && progress > m.length * 0.32 && progress < m.length * 0.69 && greenRemaining > 5.5
        && !this.nav.scramble!.isSidewalk(s.x[id], s.z[id], a.radius[id] + 0.015)) {
        this.action[id] = Action.Braking; this.stationary[id] = 1; this.remaining[id] = 2.0;
        this.counts.selfieStarts++;
      }
    }
    let pose = 0;
    switch (this.action[id]) {
      case Action.Running:
        if (progress >= m.length - 2 || side > m.width / 2 + 2) this.finish(id);
        else this.pace[id] = this.runSpeed[id] / (1.35 * Math.max(0.5, a.speedFactor[id]));
        break;
      case Action.Braking:
      case Action.Holding:
        this.pace[id] = 0; this.remaining[id] -= dt;
        if (Math.hypot(s.vx[id], s.vz[id]) < 0.22) {
          pose = 1;
          if (this.action[id] === Action.Braking) {
            this.action[id] = Action.Holding; this.remaining[id] = this.duration[id];
          }
        }
        if (this.remaining[id] <= 0) this.finish(id);
        break;
    }
    this.selfiePose[id] += clamp(pose - this.selfiePose[id], -dt * 2.8, dt * 2.1);
    if (this.action[id] === Action.Finished && this.selfiePose[id] < 0.001) {
      this.selfiePose[id] = 0; this.performers.delete(id);
    }
  }

  private finish(id: number): void {
    this.action[id] = Action.Finished; this.stationary[id] = 0; this.pace[id] = 1;
  }

  /** Called after trip and signal intentions, only when the walking step is free. Group terms act on known companions. */
  guide(id: number, dir: Direction, enhanced: boolean): number {
    const leader = this.groupLeader[id];
    if (leader < 0 || !enhanced) return this.pace[id];
    const party = this.groups.get(leader)!;
    const a = this.agents, s = a.current, x = s.x[id], z = s.z[id], m = party.mark;
    const progress = ((x - m.x) * m.ux + (z - m.z) * m.uz - m.length / 2) * party.sign;
    if (party.regroupSeconds > 0 && party.regroupSeconds < 9 && progress > m.length / 2 + 3 && progress < m.length / 2 + 12 &&
      this.nav.scramble!.isSidewalk(x, z, a.radius[id] + 0.15)) return 0.18;
    if (!this.green && !this.nav.scramble!.isSidewalk(x, z, a.radius[id] + 0.015)) return 1;
    let lateral = 0, forward = 0, alignment = 0, meanPace = a.preferredSpeed[id], seen = 0;
    for (const other of party.members) {
      if (other === id || a.portalStage[other] || a.targetId[id] !== a.targetId[other]) continue;
      const dx = s.x[other] - x, dz = s.z[other] - z;
      if (dx * dx + dz * dz > 9 * 9 || !this.nav.lineOfSight(x, z, s.x[other], s.z[other], 0)) continue;
      // Keep a side-by-side formation in open space. Under pressure the inside members tuck a half-step behind.
      const slot = this.groupSlot[id], otherSlot = this.groupSlot[other];
      lateral += dx * dir.z - dz * dir.x + (slot - otherSlot) * party.openWidth;
      forward += dx * dir.x + dz * dir.z + (Math.abs(slot) - Math.abs(otherSlot)) * (1 - party.openWidth);
      alignment += s.vx[other] * dir.z - s.vz[other] * dir.x;
      meanPace += a.preferredSpeed[other]; seen++;
    }
    if (!seen || !a.preferredSpeed[id]) return 1;
    const correction = clamp((0.65 * lateral + 0.24 * alignment) / seen, -0.64, 0.64);
    const sx = dir.x + dir.z * correction, sz = dir.z - dir.x * correction, length = Math.hypot(sx, sz);
    if (length > 0) { dir.x = sx / length; dir.z = sz / length; }
    return clamp(meanPace / ((seen + 1) * a.preferredSpeed[id]) + 0.28 * forward / seen, 0.65, 1.32);
  }

  /** A replacement life cannot inherit a trip, camera pose or relationship from its previous occupant. */
  reset(id: number): void {
    const leader = this.groupLeader[id];
    if (leader >= 0) {
      const party = this.groups.get(leader)!;
      party.members = party.members.filter(member => member !== id);
      if (party.members.length < 2) {
        for (const other of party.members) {
          this.groupLeader[other] = -1; this.groupTrackKey[other] = -1;
          this.groupSlot[other] = 0; this.role[other] = ActivityRole.Walker;
        }
        this.groups.delete(leader);
      } else {
        const successor = leader === id ? party.members[Math.floor(party.members.length / 2)] : leader;
        if (successor !== leader) { this.groups.delete(leader); this.groups.set(successor, party); }
        party.members.forEach((member, rank) => {
          this.groupLeader[member] = successor; this.groupSlot[member] = (rank - (party.members.length - 1) / 2) * 0.84;
        });
      }
    }
    this.performers.delete(id); this.soloMark[id] = undefined; this.groupLeader[id] = -1; this.groupSlot[id] = 0;
    this.groupTrackKey[id] = -1;
    this.role[id] = ActivityRole.Walker; this.action[id] = Action.Ready; this.pace[id] = 1;
    this.selfiePose[id] = 0; this.stationary[id] = 0;
  }
}
