import { describe, expect, it } from 'vitest';
import { pickBestSeats, type SeatForPicking } from '../../src/modules/bookings/best-seats.js';

/**
 * Build seats from a picture: one string per row, "." free, "X" taken, " " no seat (an aisle).
 * Seat ids are 100 * row + column, so a block reads like [3, 4] = row 0, columns 3-4.
 */
function rows(
  picture: string[],
  { section = 'Floor', sectionOrder = 0, firstRow = 0, priceCents = 5000 } = {},
): SeatForPicking[] {
  return picture.flatMap((line, r) =>
    [...line].flatMap((ch, x) =>
      ch === ' '
        ? []
        : [
            {
              id: (firstRow + r) * 100 + x,
              section,
              sectionOrder,
              x,
              y: firstRow + r,
              priceCents,
              available: ch === '.',
            },
          ],
    ),
  );
}

describe('pickBestSeats', () => {
  it('takes adjacent seats in the front row, as near the middle as possible', () => {
    const [best] = pickBestSeats(rows(['.......', '.......']), { quantity: 3 });
    expect(best).toEqual([2, 3, 4]); // the middle three of seven, front row
  });

  it('only joins seats that are side by side (an aisle or a taken seat splits them)', () => {
    const [best] = pickBestSeats(rows(['..X..', '.. ..', '.....']), { quantity: 3 });
    // Rows 0 and 1 have no 3 seats together. In row 2 the centred block [201-203] would
    // strand seats 200 and 204, so the block goes against the end of the row.
    expect(best).toEqual([200, 201, 202]);
  });

  it('prefers the front section, then the row nearest the stage', () => {
    const seats = [
      ...rows(['XXXXX', 'XX..X'], { section: 'Stalls', sectionOrder: 0 }),
      ...rows(['.....'], { section: 'Circle', sectionOrder: 1, firstRow: 2 }),
    ];
    expect(pickBestSeats(seats, { quantity: 2 })[0]).toEqual([102, 103]);
  });

  it('keeps the buyer in the better section, even if the only block there strands a seat', () => {
    const seats = [
      ...rows(['.....'], { section: 'Stalls', sectionOrder: 0 }), // any 4 of these leave 1 alone
      ...rows(['....'], { section: 'Circle', sectionOrder: 1, firstRow: 1 }),
    ];
    const [best] = pickBestSeats(seats, { quantity: 4 });
    expect(best!.every((id) => id < 100)).toBe(true);
  });

  it('never strands a single empty seat beside the block when another block in the section avoids it', () => {
    // Row 0 has 5 free seats: any 4 of them leave one alone. Row 1 has exactly 4.
    const [best] = pickBestSeats(rows(['.....', 'X....X']), { quantity: 4 });
    expect(best).toEqual([101, 102, 103, 104]);
  });

  it('still offers a stranding block when it is the only one', () => {
    expect(pickBestSeats(rows(['.....']), { quantity: 4 })).toHaveLength(1);
  });

  it('respects the price limit', () => {
    const seats = [
      ...rows(['....'], { section: 'Front', sectionOrder: 0, priceCents: 12000 }),
      ...rows(['....'], { section: 'Back', sectionOrder: 1, firstRow: 1, priceCents: 4500 }),
    ];
    // Back row only; the middle pair would strand a seat on each side.
    expect(pickBestSeats(seats, { quantity: 2, maxPriceCents: 5000 })[0]).toEqual([100, 101]);
    expect(pickBestSeats(seats, { quantity: 2, maxPriceCents: 4000 })).toEqual([]);
  });

  it('returns disjoint candidate blocks, best first, up to the limit', () => {
    const blocks = pickBestSeats(rows(['......', '......']), { quantity: 2, limit: 4 });
    expect(blocks).toHaveLength(4);
    const ids = blocks.flat();
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('finds nothing when no row has enough seats together', () => {
    expect(pickBestSeats(rows(['..X..', '.X.X.']), { quantity: 3 })).toEqual([]);
    expect(pickBestSeats(rows(['....']), { quantity: 0 })).toEqual([]);
  });
});
