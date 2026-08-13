import { describe, expect, it } from 'vitest';

import {
  BALANCE,
  BROADCAST_HZ,
  DEPTH_LADDER_SOL,
  FRAME_PULSE,
  PULSE_BYTES,
  PULSE_HZ,
  classifyTrade,
  decodePulse,
  encodePulse,
  factionForSide,
  floorsMatchReference,
  victimOf,
} from './index.js';

describe('classifyTrade', () => {
  const ref = 2_000;

  it('treats an average-sized trade as normal', () => {
    expect(classifyTrade(2_500, ref)).toBe('normal');
  });

  it('promotes to heavy at the relative multiple', () => {
    expect(classifyTrade(ref * BALANCE.relHeavyMult, ref)).toBe('heavy');
  });

  it('promotes to whale at the relative multiple', () => {
    expect(classifyTrade(ref * BALANCE.relWhaleMult, ref)).toBe('whale');
  });

  it('holds the bar at the absolute floor on a quiet market', () => {
    // With a near-zero reference, 8x would be pennies. The floor keeps a $500
    // trade ordinary and only promotes once it clears relHeavyFloor.
    expect(classifyTrade(500, 10)).toBe('normal');
    expect(classifyTrade(BALANCE.relHeavyFloor, 10)).toBe('heavy');
  });

  it('clamps a nonsensical reference to the floor', () => {
    expect(classifyTrade(BALANCE.relWhaleFloor, 0)).toBe('whale');
    expect(classifyTrade(BALANCE.relWhaleFloor - 1, 0)).toBe('heavy');
  });

  it('never promotes on a busy market at sizes a quiet one would flag', () => {
    // Same $4k trade: a whale when the market is dead, noise when it is not.
    expect(classifyTrade(4_000, 0)).toBe('whale');
    expect(classifyTrade(4_000, 5_000)).toBe('normal');
  });
});

describe('BALANCE floors', () => {
  it('keeps absolute floors reachable and relative scaling alive', () => {
    // Both mechanisms must agree at the boundary, otherwise one is dead code.
    expect(floorsMatchReference()).toBe(true);
  });
});

describe('factions', () => {
  it('maps buyers to nexus and sellers to orc', () => {
    expect(factionForSide('buy')).toBe('nexus');
    expect(factionForSide('sell')).toBe('orc');
  });

  it('makes each side kill the other', () => {
    expect(victimOf('buy')).toBe('orc');
    expect(victimOf('sell')).toBe('nexus');
  });
});

describe('DEPTH_LADDER_SOL', () => {
  it('is strictly ascending', () => {
    const rungs = [...DEPTH_LADDER_SOL];
    expect(rungs).toEqual([...rungs].sort((a, b) => a - b));
    expect(new Set(rungs).size).toBe(rungs.length);
  });
});

describe('pulse codec', () => {
  const pulse = { orcAlive: 203, nexusAlive: 138, frontLine: -0.327 };

  it('survives a round trip', () => {
    const decoded = decodePulse(encodePulse(pulse), 1_000);
    expect(decoded).toEqual({ type: 'pulse', t: 1_000, ...pulse });
  });

  it('stays the size the bandwidth argument was made on', () => {
    // The codec exists because 10 Hz of JSON cost more than the trade stream it
    // replaces. Grow the frame and that reason quietly stops holding, so pin it:
    // a pulse must stay far cheaper than the JSON it would otherwise be.
    const asJson = JSON.stringify({ type: 'pulse', t: Date.now(), ...pulse });
    expect(encodePulse(pulse).byteLength).toBe(PULSE_BYTES);
    expect(PULSE_BYTES * 8).toBeLessThan(asJson.length);
  });

  it('carries the whole front line range at pixel-level precision', () => {
    for (const frontLine of [-1, -0.5, 0, 0.0001, 0.5, 1]) {
      const decoded = decodePulse(encodePulse({ ...pulse, frontLine }));
      expect(decoded?.frontLine).toBeCloseTo(frontLine, 4);
    }
  });

  it('clamps rather than throwing, because it runs in the broadcast loop', () => {
    // A simulation bug must not be able to take the socket down for everyone.
    // A pinned counter is a far better failure than a dead stream.
    const over = decodePulse(
      encodePulse({ orcAlive: -5, nexusAlive: 99_999, frontLine: 4 }),
    );
    expect(over).toEqual({
      type: 'pulse',
      t: over?.t,
      orcAlive: 0,
      nexusAlive: 65_535,
      frontLine: 1,
    });
  });

  it('refuses frames that are not pulses', () => {
    expect(decodePulse(new ArrayBuffer(PULSE_BYTES - 1))).toBeNull();
    expect(decodePulse(new ArrayBuffer(PULSE_BYTES + 1))).toBeNull();

    const wrongKind = encodePulse(pulse);
    new DataView(wrongKind).setUint8(0, FRAME_PULSE + 1);
    expect(decodePulse(wrongKind)).toBeNull();
  });

  it('cannot outrun the broadcast that carries it', () => {
    // The hub flushes at BROADCAST_HZ. A pulse rate above that would not make
    // the battle smoother — it would queue frames and deliver them in bursts,
    // which is worse than the lower rate it was meant to improve on.
    expect(PULSE_HZ).toBeLessThanOrEqual(BROADCAST_HZ);
  });

  it('costs less at its own rate than one JSON frame a second would', () => {
    // The argument that justified a hand-rolled codec, pinned as arithmetic.
    const asJson = JSON.stringify({
      type: 'pulse',
      t: Date.now(),
      orcAlive: 203,
      nexusAlive: 138,
      frontLine: -0.327,
    }).length;
    expect(PULSE_BYTES * PULSE_HZ).toBeLessThan(asJson);
  });

  it('stamps arrival time, since the wire does not carry it', () => {
    // Dropping `t` from the frame saves 13 digits ten times a second.
    expect(decodePulse(encodePulse(pulse), 42)?.t).toBe(42);
  });
});
