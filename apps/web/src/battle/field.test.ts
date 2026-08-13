import { BALANCE, type Pulse } from '@sol-warzone/protocol';
import { describe, expect, it } from 'vitest';

import { BattleField } from './field.js';

/** Seeded, so a layout assertion cannot flake into a green run. */
function seeded(seed = 20_260_813): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const pulse = (
  orcAlive: number,
  nexusAlive: number,
  frontLine = 0,
): Omit<Pulse, 'type' | 't'> => ({ orcAlive, nexusAlive, frontLine });

/** Run the field forward at 60 fps. */
function run(field: BattleField, seconds: number): void {
  for (let i = 0; i < seconds * 60; i++) field.advance(1_000 / 60);
}

const field = (): BattleField => new BattleField({ random: seeded() });

describe('first pulse', () => {
  it('builds the field from the counts rather than growing into them', () => {
    // Nobody should watch two hundred units walk in when they open the page.
    const f = field();
    f.applyPulse(pulse(203, 138));

    expect(f.countOf('orc')).toBe(203);
    expect(f.countOf('nexus')).toBe(138);
  });

  it('places the two sides on opposite halves', () => {
    const f = field();
    f.applyPulse(pulse(50, 50));

    const orcs = f.units.filter((u) => u.faction === 'orc');
    const nexus = f.units.filter((u) => u.faction === 'nexus');
    expect(Math.max(...orcs.map((u) => u.y))).toBeLessThan(0.5);
    expect(Math.min(...nexus.map((u) => u.y))).toBeGreaterThan(0.5);
  });
});

describe('casualties', () => {
  it('takes them at once, because a whale is a blow and not a trend', () => {
    const f = field();
    f.applyPulse(pulse(200, 200));
    run(f, 2);

    f.applyPulse(pulse(140, 200));
    f.advance(1_000 / 60);

    // Sixty gone inside a single frame — spreading that over two seconds would
    // turn the loudest event in the product into a slow leak.
    expect(f.countOf('orc')).toBe(140);
  });

  it('kills at the front, not at random across the field', () => {
    // Same arithmetic, different picture: deletions scattered over the field
    // read as a rendering fault rather than as fighting.
    const f = field();
    f.applyPulse(pulse(120, 120));
    run(f, 6);

    const front = f.frontY;
    const before = f.units.filter((u) => u.faction === 'orc');
    const rearmost = Math.max(...before.map((u) => Math.abs(u.y - front)));

    f.applyPulse(pulse(100, 120));
    f.advance(1_000 / 60);

    const dying = f.units.filter((u) => u.faction === 'orc' && u.state === 'dying');
    expect(dying).toHaveLength(20);
    for (const unit of dying) {
      expect(Math.abs(unit.y - front)).toBeLessThan(rearmost);
    }
  });

  it('keeps the dead on screen briefly without counting them', () => {
    // The death animation has to play, but a corpse that still counts would
    // stop the field ever converging on the target.
    const f = field();
    f.applyPulse(pulse(100, 100));
    f.applyPulse(pulse(90, 100));
    f.advance(1_000 / 60);

    expect(f.countOf('orc')).toBe(90);
    expect(f.units.filter((u) => u.faction === 'orc')).toHaveLength(100);

    run(f, 1);
    expect(f.units.filter((u) => u.state === 'dying')).toHaveLength(0);
  });
});

describe('reinforcements', () => {
  it('walks them in rather than popping them into place', () => {
    const f = field();
    f.applyPulse(pulse(100, 100));
    run(f, 2);

    f.applyPulse(pulse(130, 100));
    f.advance(1_000 / 60);
    // One frame in, only a couple have arrived: a side that recovers thirty
    // units instantly reads as a spawn bug, not as a rally.
    expect(f.countOf('orc')).toBeLessThan(110);

    run(f, 3);
    expect(f.countOf('orc')).toBe(130);
  });

  it('starts them at the base, behind the line', () => {
    const f = field();
    f.applyPulse(pulse(100, 100));
    run(f, 5);
    const front = f.frontY;

    f.applyPulse(pulse(140, 100));
    // Long enough for the trickle to produce someone, short enough that they
    // are still arriving rather than already marching.
    run(f, 0.1);

    const fresh = f.units.filter((u) => u.state === 'spawning');
    expect(fresh.length).toBeGreaterThan(0);
    for (const unit of fresh) expect(unit.y).toBeLessThan(front);
  });
});

describe('divergence', () => {
  it('snaps when the gap is too large to have been watched', () => {
    const f = field();
    f.applyPulse(pulse(200, 200));
    run(f, 2);
    const before = f.resyncs;

    // The kind of jump only a client that stopped rendering could produce.
    f.applyPulse(pulse(60, 240));
    expect(f.resyncs).toBe(before + 1);
    expect(f.countOf('orc')).toBe(60);
    expect(f.countOf('nexus')).toBe(240);
  });

  it('snaps when nothing has been drawn for a while, whatever the gap', () => {
    // A backgrounded tab: the socket kept delivering, the renderer did not.
    // Animating through the backlog would be a minute of visible fiction.
    const f = field();
    f.applyPulse(pulse(200, 200));
    run(f, 2);
    const before = f.resyncs;

    f.applyPulse(pulse(198, 201), 5_000);
    expect(f.resyncs).toBe(before + 1);
  });

  it('animates through an ordinary tick instead of snapping', () => {
    const f = field();
    f.applyPulse(pulse(200, 200));
    run(f, 2);
    const before = f.resyncs;

    for (let i = 0; i < 20; i++) {
      f.applyPulse(pulse(200 - i, 200), 100);
      run(f, 0.1);
    }
    expect(f.resyncs).toBe(before);
  });
});

describe('formation', () => {
  it('gives the army depth instead of one long line', () => {
    // Two hundred units on a single line looked fine from directly overhead
    // and became one glowing stripe the moment a perspective camera was
    // pointed at it. Ranks are what make the mass read as an army.
    const f = field();
    f.applyPulse(pulse(200, 200));
    run(f, 8);

    const orcs = f.units.filter((u) => u.faction === 'orc').map((u) => u.y);
    const spread = Math.max(...orcs) - Math.min(...orcs);
    expect(spread).toBeGreaterThan(0.1);
    // …but still an army facing a line, not a crowd filling the field.
    expect(spread).toBeLessThan(0.25);
  });

  it('holds the ranks in order, closest to the front first', () => {
    const f = field();
    f.applyPulse(pulse(200, 200));
    run(f, 8);

    const front = f.frontY;
    const orcs = f.units.filter((u) => u.faction === 'orc');
    for (const unit of orcs) {
      // Orcs hold the near side of the line, and deeper ranks stand further
      // back from it — never on the far side of it.
      expect(unit.y).toBeLessThan(front);
    }
    const contact = orcs.filter((u) => u.rank === 0).map((u) => u.y);
    const reserve = orcs.filter((u) => u.rank >= 5).map((u) => u.y);
    expect(Math.max(...reserve)).toBeLessThan(Math.min(...contact));
  });

  it('spaces the files across the width', () => {
    const f = field();
    f.applyPulse(pulse(200, 200));
    run(f, 1);

    const xs = f.units.map((u) => u.x).sort((a, b) => a - b);
    expect(xs[0]).toBeLessThan(0.1);
    expect(xs[xs.length - 1]).toBeGreaterThan(0.9);
  });
});

describe('events', () => {
  it('reports a death where the unit was standing', () => {
    // An effect drawn anywhere but on the casualty is worse than no effect:
    // it says something happened over there, and nothing did.
    const f = field();
    f.applyPulse(pulse(120, 120));
    run(f, 4);

    const before = f.units
      .filter((u) => u.faction === 'orc')
      .map((u) => `${u.x},${u.y}`);
    f.applyPulse(pulse(100, 120));
    f.advance(1_000 / 60);

    const deaths = f.events.filter((e) => e.kind === 'death');
    expect(deaths).toHaveLength(20);
    for (const death of deaths) {
      expect(death.faction).toBe('orc');
      expect(before).toContain(`${death.x},${death.y}`);
    }
  });

  it('describes one step and not the ones before it', () => {
    const f = field();
    f.applyPulse(pulse(120, 120));
    f.advance(1_000 / 60);
    f.applyPulse(pulse(110, 120));
    f.advance(1_000 / 60);
    expect(f.events.length).toBeGreaterThan(0);

    // Nothing new happened, so nothing should be reported again — otherwise a
    // renderer that plays events every frame plays each death forever.
    f.advance(1_000 / 60);
    expect(f.events).toHaveLength(0);
  });

  it('says nothing at all about a resync', () => {
    // Rebuilding the field is the picture admitting it lost the thread, not
    // four hundred units arriving at once.
    const f = field();
    f.applyPulse(pulse(200, 200));
    run(f, 2);

    f.applyPulse(pulse(60, 240));
    f.advance(1_000 / 60);

    expect(f.resyncs).toBe(2);
    expect(f.events).toHaveLength(0);
  });
});

describe('front line', () => {
  it('eases between pulses instead of jumping every hundred milliseconds', () => {
    const f = field();
    f.applyPulse(pulse(200, 200, 0));
    run(f, 2);
    const centred = f.frontY;

    f.applyPulse(pulse(200, 200, 0.8));
    f.advance(1_000 / 60);
    const afterOneFrame = f.frontY;

    run(f, 3);
    const settled = f.frontY;

    expect(Math.abs(afterOneFrame - centred)).toBeLessThan(0.05);
    expect(settled).toBeLessThan(centred);
  });

  it('moves toward the losing side', () => {
    // frontLine is positive when the Nexus leads, and the Nexus holds the
    // bottom — so its advance pushes the line up, toward the orc base.
    const f = field();
    f.applyPulse(pulse(100, 240, 0.9));
    run(f, 4);
    expect(f.frontY).toBeLessThan(0.3);
  });

  it('brings the armies with it', () => {
    const f = field();
    f.applyPulse(pulse(150, 150, 0));
    run(f, 5);
    const settledOrcs = average(f.units.filter((u) => u.faction === 'orc'));

    f.applyPulse(pulse(150, 150, 0.9));
    run(f, 6);
    expect(average(f.units.filter((u) => u.faction === 'orc'))).toBeLessThan(
      settledOrcs,
    );
  });
});

describe('frames that should not have been sent', () => {
  // A pulse is seven bytes of binary decoded without a schema. Everything here
  // is unreachable from a healthy server, which is precisely why none of it
  // would be caught in production before it had been running for an hour.

  it('will not grow the army past the pool, whatever the count says', () => {
    // orcAlive is a u16 on the wire: it can say 65535 against a pool of 250.
    // Reinforcement is a trickle, so the failure is not a spike — it is an
    // array that grows at twenty-five a second for as long as the tab is open.
    const f = field();
    f.applyPulse(pulse(65_535, 65_535));
    run(f, 20);

    expect(f.countOf('orc')).toBeLessThanOrEqual(BALANCE.poolPerSide);
    expect(f.countOf('nexus')).toBeLessThanOrEqual(BALANCE.poolPerSide);
  });

  it('keeps the front line on the field', () => {
    // frontLine is fixed-point over an int16, so a corrupted frame decodes as
    // far as ±3.27. Unclamped that is a front line off the end of the field,
    // and both armies marching after it.
    const f = field();
    f.applyPulse(pulse(100, 100, 3.27));
    run(f, 6);
    expect(f.frontY).toBeGreaterThan(0);
    expect(f.frontY).toBeLessThan(1);

    f.applyPulse(pulse(100, 100, -3.27));
    run(f, 6);
    expect(f.frontY).toBeGreaterThan(0);
    expect(f.frontY).toBeLessThan(1);
  });

  it('treats a number that is not one as the safest number it could be', () => {
    // NaN compares false against everything, so a clamp written the obvious way
    // passes it straight through — and a NaN front line is a camera and an army
    // that never come back, because every later frame eases toward it.
    const f = field();
    f.applyPulse(pulse(100, 100));
    run(f, 2);

    f.applyPulse(pulse(Number.NaN, Number.NaN, Number.NaN));
    run(f, 2);

    expect(Number.isFinite(f.frontY)).toBe(true);
    for (const unit of f.units) {
      expect(Number.isFinite(unit.x)).toBe(true);
      expect(Number.isFinite(unit.y)).toBe(true);
    }
  });

  it('treats a negative count as zero rather than as a direction', () => {
    const f = field();
    f.applyPulse(pulse(100, 100));
    run(f, 2);
    f.applyPulse(pulse(-5, 100));
    run(f, 2);
    expect(f.countOf('orc')).toBe(0);
  });

  it('keeps every unit on the field, however hard the line pulls', () => {
    const f = field();
    f.applyPulse(pulse(200, 200, 1));
    run(f, 20);
    f.applyPulse(pulse(200, 200, -1));
    run(f, 20);

    for (const unit of f.units) {
      expect(unit.x).toBeGreaterThanOrEqual(0);
      expect(unit.x).toBeLessThanOrEqual(1);
      expect(unit.y).toBeGreaterThan(-0.1);
      expect(unit.y).toBeLessThan(1.1);
    }
  });
});

describe('a step of no time', () => {
  it('changes nothing', () => {
    const f = field();
    f.applyPulse(pulse(120, 120));
    run(f, 2);
    const before = f.units.map((u) => `${u.id}:${u.x}:${u.y}:${u.state}`);

    f.advance(0);
    f.advance(-16);
    f.advance(Number.NaN);

    expect(f.units.map((u) => `${u.id}:${u.x}:${u.y}:${u.state}`)).toEqual(before);
  });

  it('does not hand the same deaths out twice', () => {
    // Two animation frames can carry the same timestamp, and a renderer that
    // plays `events` on every draw would fire a second burst of sparks over
    // corpses that are already falling.
    const f = field();
    f.applyPulse(pulse(120, 120));
    run(f, 3);
    f.applyPulse(pulse(100, 120));
    f.advance(1_000 / 60);
    expect(f.events.filter((e) => e.kind === 'death')).toHaveLength(20);

    f.advance(0);
    expect(f.events).toHaveLength(0);
  });
});

describe('the resync threshold', () => {
  it('animates a gap it could have watched, and snaps at one it could not', () => {
    // The boundary itself, because it is the number that decides between a
    // second of visible fiction and a jump, and nothing else pins it.
    const atLimit = field();
    atLimit.applyPulse(pulse(200, 200));
    run(atLimit, 2);
    atLimit.applyPulse(pulse(160, 200), 100);
    expect(atLimit.resyncs).toBe(1);

    const overLimit = field();
    overLimit.applyPulse(pulse(200, 200));
    run(overLimit, 2);
    overLimit.applyPulse(pulse(159, 200), 100);
    expect(overLimit.resyncs).toBe(2);
  });

  it('counts both sides together, since both are on the same screen', () => {
    // Thirty missing orcs and thirty new Nexus is sixty units of difference
    // and reads as badly as sixty on one side.
    const f = field();
    f.applyPulse(pulse(200, 200));
    run(f, 2);
    f.applyPulse(pulse(170, 230), 100);
    expect(f.resyncs).toBe(2);
  });
});

describe('convergence', () => {
  it('holds the counts the server gave it over a long run', () => {
    // The one property everything else exists to serve: the picture must not
    // drift away from the numbers it is drawn from.
    const f = field();
    f.applyPulse(pulse(200, 200));
    run(f, 2);

    let orc = 200;
    for (let tick = 0; tick < 200; tick++) {
      orc += tick % 3 === 0 ? -4 : 2;
      orc = Math.max(60, Math.min(250, orc));
      f.applyPulse(pulse(orc, 200, (200 - orc) / 250), 100);
      run(f, 0.1);
    }

    run(f, 3);
    expect(f.countOf('orc')).toBe(orc);
    expect(f.countOf('nexus')).toBe(200);
    // And it got there by animating, not by giving up and snapping.
    expect(f.resyncs).toBe(1);
  });
});

const average = (units: readonly { y: number }[]): number =>
  units.reduce((sum, unit) => sum + unit.y, 0) / Math.max(1, units.length);
