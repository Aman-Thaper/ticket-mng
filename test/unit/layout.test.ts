import { describe, expect, it } from 'vitest';
import { generateSeats, rowLabel } from '../../src/modules/venues/layout.js';

describe('rowLabel', () => {
  it.each([
    [0, 'A'],
    [25, 'Z'],
    [26, 'AA'],
    [27, 'AB'],
    [51, 'AZ'],
    [52, 'BA'],
    [701, 'ZZ'],
    [702, 'AAA'],
  ])('%i → %s', (i, label) => expect(rowLabel(i)).toBe(label));
});

describe('generateSeats', () => {
  const seats = generateSeats([
    { name: 'Floor', rows: 2, seatsPerRow: 4 },
    { name: 'Balcony', rows: 1, seatsPerRow: 2 },
  ]);

  it('creates rows × seatsPerRow seats per section', () => {
    expect(seats).toHaveLength(2 * 4 + 1 * 2);
  });

  it('gives every seat a unique grid position', () => {
    const positions = new Set(seats.map((s) => `${s.x},${s.y}`));
    expect(positions.size).toBe(seats.length);
  });

  it('centers narrower sections and leaves a gap between sections', () => {
    const balcony = seats.filter((s) => s.section === 'Balcony');
    expect(balcony.map((s) => s.x)).toEqual([1, 2]);
    expect(balcony[0]!.y).toBe(2 + 2); // 2 floor rows + gap of 2
  });
});
