import { BALANCE, type Faction, type Pulse } from '@sol-warzone/protocol';

/**
 * The client's half of the battle: the picture.
 *
 * The server owns the score (PLAN.md §7) — this owns nothing but appearances.
 * It is handed `orcAlive`, `nexusAlive` and `frontLine` ten times a second and
 * has to show a field that does not contradict them.
 *
 * The hard part is not the rules, which live on the server, but reconciliation.
 * "Orcs went from 203 to 197" and "remove six dots" are the same arithmetic and
 * different pictures: six deaths at the front read as combat, six deletions
 * scattered across the field read as a rendering bug.
 *
 * No canvas and no timers here, so a population can be driven from a recorded
 * pulse stream in a test and its shape asserted.
 */

export type UnitState = 'spawning' | 'marching' | 'fighting' | 'dying';

export interface Unit {
  readonly id: number;
  readonly faction: Faction;
  /** Normalised field coordinates, 0…1 on both axes. */
  x: number;
  y: number;
  state: UnitState;
  /** Seconds spent in the current state. */
  stateAge: number;
}

/**
 * Where each side lives. Orcs hold the top edge and the Nexus the bottom, as
 * the reference does, so the front line reads as a horizontal band.
 */
const ORC_BASE_Y = 0.08;
const NEXUS_BASE_Y = 0.92;

/** How far the front line may travel from centre before it looks like a rout. */
const FRONT_TRAVEL = 0.34;

const SPAWN_SEC = 0.4;
const DEATH_SEC = 0.5;

/** Reinforcements walk in; casualties do not wait. See `#reconcile`. */
const SPAWNS_PER_SEC = 25;

/**
 * Unit gap that means the client lost the thread rather than fell behind.
 *
 * A backgrounded tab stops rendering while the socket keeps delivering, so a
 * returning client can be dozens out. Catching that up a few at a time is a
 * minute of visible fiction; snapping is honest and over in one frame.
 */
const RESYNC_GAP = 40;

/** …and the same conclusion from the other direction: nothing drawn for this long. */
const RESYNC_STALL_MS = 1_000;

export interface BattleFieldOptions {
  /** Seeded in tests so a layout assertion cannot flake. */
  random?: () => number;
}

export class BattleField {
  readonly #random: () => number;
  #units: Unit[] = [];
  #nextId = 1;

  #frontLine = 0;
  #targetFrontLine = 0;
  #target: Record<Faction, number> = { orc: 0, nexus: 0 };
  /** Fractional spawn credit, so a slow trickle is not rounded away each frame. */
  #spawnCredit: Record<Faction, number> = { orc: 0, nexus: 0 };
  #sawFirstPulse = false;
  #resyncs = 0;

  constructor(options: BattleFieldOptions = {}) {
    this.#random = options.random ?? Math.random;
  }

  get units(): readonly Unit[] {
    return this.#units;
  }

  /** Front line as a y coordinate, 0…1. Drawn, and marched toward. */
  get frontY(): number {
    return 0.5 - this.#frontLine * FRONT_TRAVEL;
  }

  /** How many times the picture had to snap rather than animate. */
  get resyncs(): number {
    return this.#resyncs;
  }

  /** Units that count toward the total. The dying are on screen but spent. */
  countOf(faction: Faction): number {
    return this.#units.filter(
      (unit) => unit.faction === faction && unit.state !== 'dying',
    ).length;
  }

  /**
   * Take the authoritative counts.
   *
   * `elapsedSinceDraw` lets a returning tab say how long it was away: a large
   * gap is only worth animating through if the client was actually watching.
   */
  applyPulse(pulse: Omit<Pulse, 'type' | 't'>, elapsedSinceDraw = 0): void {
    this.#target = { orc: pulse.orcAlive, nexus: pulse.nexusAlive };
    this.#targetFrontLine = pulse.frontLine;

    const gap =
      Math.abs(pulse.orcAlive - this.countOf('orc')) +
      Math.abs(pulse.nexusAlive - this.countOf('nexus'));

    if (
      !this.#sawFirstPulse ||
      gap > RESYNC_GAP ||
      elapsedSinceDraw > RESYNC_STALL_MS
    ) {
      this.#resync();
      this.#sawFirstPulse = true;
    }
  }

  /** Advance the picture by `dtMs`. */
  advance(dtMs: number): void {
    if (!(dtMs > 0)) return;
    const dt = dtMs / 1_000;

    // The front line eases rather than snapping: pulses are 100 ms apart and
    // frames are 16, so six frames of every ten would otherwise be still.
    this.#frontLine += (this.#targetFrontLine - this.#frontLine) * Math.min(1, dt * 6);

    this.#age(dt);
    this.#reconcile(dt);
    this.#march(dt);
  }

  #age(dt: number): void {
    for (const unit of this.#units) {
      unit.stateAge += dt;
      if (unit.state === 'spawning' && unit.stateAge >= SPAWN_SEC) {
        unit.state = 'marching';
        unit.stateAge = 0;
      }
    }
    this.#units = this.#units.filter(
      (unit) => !(unit.state === 'dying' && unit.stateAge >= DEATH_SEC),
    );
  }

  /**
   * Close the gap between what is drawn and what the server says.
   *
   * Deliberately asymmetric. Casualties land at once, because a whale should
   * read as a blow and a blow spread over two seconds is not one. Reinforcements
   * trickle, because they are supposed to be walking in from the base — a side
   * that recovers forty units instantly looks like a spawn bug, not a rally.
   */
  #reconcile(dt: number): void {
    for (const faction of ['orc', 'nexus'] as const) {
      const alive = this.countOf(faction);
      const target = this.#target[faction];

      if (alive > target) {
        this.#kill(faction, alive - target);
        this.#spawnCredit[faction] = 0;
        continue;
      }

      if (alive < target) {
        this.#spawnCredit[faction] += SPAWNS_PER_SEC * dt;
        const due = Math.min(Math.floor(this.#spawnCredit[faction]), target - alive);
        if (due > 0) {
          this.#spawnCredit[faction] -= due;
          for (let i = 0; i < due; i++) this.#spawn(faction, 'spawning');
        }
      }
    }
  }

  /** Kill the units closest to the front, so losses land where the fighting is. */
  #kill(faction: Faction, count: number): void {
    const front = this.frontY;
    const candidates = this.#units
      .filter((unit) => unit.faction === faction && unit.state !== 'dying')
      .sort((a, b) => Math.abs(a.y - front) - Math.abs(b.y - front))
      .slice(0, count);

    for (const unit of candidates) {
      unit.state = 'dying';
      unit.stateAge = 0;
    }
  }

  #spawn(faction: Faction, state: UnitState): void {
    const baseY = faction === 'orc' ? ORC_BASE_Y : NEXUS_BASE_Y;
    this.#units.push({
      id: this.#nextId++,
      faction,
      x: 0.06 + this.#random() * 0.88,
      // Spread the base band a little so reinforcements are not a straight line.
      y: baseY + (this.#random() - 0.5) * 0.06,
      state,
      stateAge: 0,
    });
  }

  /**
   * Walk toward the front and hold there.
   *
   * Not boids: a unit seeks the line, slows as it arrives, and drifts sideways
   * away from whoever is nearest. That is enough for the mass to read as two
   * armies, which is all this prototype has to prove.
   */
  #march(dt: number): void {
    const front = this.frontY;
    for (const unit of this.#units) {
      if (unit.state === 'dying' || unit.state === 'spawning') continue;

      const stopAt = unit.faction === 'orc' ? front - 0.02 : front + 0.02;
      const toFront = stopAt - unit.y;
      const distance = Math.abs(toFront);

      unit.state = distance < 0.03 ? 'fighting' : 'marching';
      // Arrive: full speed far out, easing to nothing at the line, so the front
      // is a band of held positions rather than a pile-up.
      const speed = 0.22 * Math.min(1, distance / 0.15);
      unit.y += Math.sign(toFront) * speed * dt;
      unit.x = clamp01(unit.x + (this.#random() - 0.5) * 0.04 * dt);
    }
  }

  /** Discard the picture and rebuild it from the counts, without animation. */
  #resync(): void {
    this.#units = [];
    this.#spawnCredit = { orc: 0, nexus: 0 };
    this.#frontLine = this.#targetFrontLine;
    this.#resyncs++;

    for (const faction of ['orc', 'nexus'] as const) {
      const count = Math.min(this.#target[faction], BALANCE.poolPerSide);
      for (let i = 0; i < count; i++) this.#spawn(faction, 'marching');
    }
  }
}

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);
