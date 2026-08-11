import { describe, expect, it } from 'vitest';

import { age, clock, num, pct, usd, usdCompact } from './format.js';

describe('usdCompact', () => {
  it.each([
    [0, '$0.00'],
    [12.5, '$12.50'],
    [999, '$999.00'],
    [1_000, '$1.0K'],
    [88_400, '$88.4K'],
    [1_900_000, '$1.90M'],
    [8_050_000, '$8.05M'],
    [2_400_000_000, '$2.40B'],
  ])('renders %d as %s', (value, expected) => {
    expect(usdCompact(value)).toBe(expected);
  });

  it('keeps the sign on negative flow', () => {
    // Net flow goes negative whenever sellers lead; dropping the sign would
    // invert the reading.
    expect(usdCompact(-10_000)).toBe('-$10.0K');
    expect(usdCompact(-1_500_000)).toBe('-$1.50M');
  });

  it('switches unit exactly at the boundary, not near it', () => {
    expect(usdCompact(999.99)).toBe('$999.99');
    expect(usdCompact(1_000)).toBe('$1.0K');
    expect(usdCompact(999_999)).toBe('$1000.0K');
    expect(usdCompact(1_000_000)).toBe('$1.00M');
  });
});

describe('pct', () => {
  it('takes a fraction and prints a percent', () => {
    // The wire carries fractions throughout; a unit slip here is the 100x bug
    // that priceChange24h already caused once.
    expect(pct(0.0142, 2)).toBe('+1.42%');
    expect(pct(-0.0142, 2)).toBe('-1.42%');
  });

  it('always signs the value, including zero', () => {
    expect(pct(0)).toBe('+0.000%');
  });

  it('defaults to three decimals for tick-sized moves', () => {
    expect(pct(0.00008)).toBe('+0.008%');
  });

  it('does not round a small move away to nothing', () => {
    expect(pct(0.000004, 4)).toBe('+0.0004%');
  });
});

describe('usd', () => {
  it('renders a price with two decimals', () => {
    expect(usd(76.5)).toBe('$76.50');
    expect(usd(1234.567)).toBe('$1,234.57');
  });
});

describe('num', () => {
  it('groups thousands so ladder sizes stay readable', () => {
    expect(num(150_000)).toBe('150,000');
    expect(num(10)).toBe('10');
  });
});

describe('age', () => {
  const now = 1_000_000;

  it('shows seconds under a minute', () => {
    expect(age(now - 3_000, now)).toBe('3s');
    expect(age(now - 59_000, now)).toBe('59s');
  });

  it('shows minutes and seconds beyond that', () => {
    expect(age(now - 61_000, now)).toBe('1m01s');
  });

  it('shows hours for a long-stale value', () => {
    expect(age(now - 3_720_000, now)).toBe('1h02m');
  });

  it('renders a dash rather than a number when nothing has arrived', () => {
    expect(age(null, now)).toBe('—');
    expect(age(0, now)).toBe('—');
  });

  it('never shows a negative age from clock skew', () => {
    // The collector stamps events; a browser clock running behind must not
    // produce "-4s".
    expect(age(now + 4_000, now)).toBe('0s');
  });
});

describe('clock', () => {
  it('renders UTC time of day', () => {
    expect(clock(Date.UTC(2026, 7, 11, 20, 25, 15))).toBe('20:25:15');
  });
});
