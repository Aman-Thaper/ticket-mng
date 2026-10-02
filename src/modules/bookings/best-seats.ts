/*
 * "Best available": find blocks of adjacent free seats, best first.
 *
 * A pure function over the seat map, so it's easy to test and reason about. The caller holds
 * the first block with the normal, concurrency-safe hold, and moves on to the next one if a
 * competing buyer got there first.
 *
 *   1. Seats sit on a grid: x within a row, y down the venue (src/modules/venues/layout.ts).
 *      Within one section's row, seats with consecutive x are side by side.
 *   2. Split every row into runs of free seats within the price limit, and slide a window of
 *      `quantity` seats along each run.
 *   3. Rank windows: front section first (venue sections are listed stage-first). Within a
 *      section, avoid leaving a single empty seat stranded next to the block (between it and
 *      a taken seat or the end of the row): nobody books a lone seat, so it would go unsold,
 *      and box offices apply the same rule. Then the row nearest the stage, then the window
 *      nearest the middle of the row, then price.
 *   4. The stranding rule never pushes a buyer into a worse section: they asked for the best
 *      seats, and a lone seat is a smaller loss than a downgrade.
 */

export interface SeatForPicking {
  id: number;
  section: string;
  /** venue_sections.sort_order: 0 is the section nearest the stage */
  sectionOrder: number;
  x: number;
  y: number;
  priceCents: number;
  /** free to take right now (lapsed holds count as free) */
  available: boolean;
}

export interface PickOptions {
  quantity: number;
  maxPriceCents?: number;
  /** how many disjoint candidate blocks to return (default 5) */
  limit?: number;
}

interface Window {
  seatIds: number[];
  strandsASeat: boolean;
  sectionOrder: number;
  rowInSection: number;
  offCentre: number;
  priceCents: number;
}

/** Up to `limit` disjoint blocks of `quantity` adjacent seats (ids, left to right), best first. */
export function pickBestSeats(seats: SeatForPicking[], { quantity, maxPriceCents, limit = 5 }: PickOptions) {
  if (quantity < 1) return [];

  const rows = new Map<string, SeatForPicking[]>();
  const firstRowOfSection = new Map<string, number>();
  for (const seat of seats) {
    const key = `${seat.section}\u0000${seat.y}`;
    let row = rows.get(key);
    if (!row) rows.set(key, (row = []));
    row.push(seat);
    firstRowOfSection.set(seat.section, Math.min(firstRowOfSection.get(seat.section) ?? seat.y, seat.y));
  }

  const windows: Window[] = [];
  for (const row of rows.values()) {
    row.sort((a, b) => a.x - b.x);
    const centre = (row[0]!.x + row.at(-1)!.x) / 2;
    const usable = (s: SeatForPicking) =>
      s.available && (maxPriceCents === undefined || s.priceCents <= maxPriceCents);

    // Runs of usable seats with consecutive x.
    let start = 0;
    while (start < row.length) {
      if (!usable(row[start]!)) {
        start++;
        continue;
      }
      let end = start;
      while (end + 1 < row.length && usable(row[end + 1]!) && row[end + 1]!.x === row[end]!.x + 1) end++;
      const run = row.slice(start, end + 1);

      for (let i = 0; i + quantity <= run.length; i++) {
        const block = run.slice(i, i + quantity);
        const left = i;
        const right = run.length - (i + quantity);
        windows.push({
          seatIds: block.map((s) => s.id),
          strandsASeat: left === 1 || right === 1,
          sectionOrder: block[0]!.sectionOrder,
          rowInSection: block[0]!.y - firstRowOfSection.get(block[0]!.section)!,
          offCentre: Math.abs((block[0]!.x + block.at(-1)!.x) / 2 - centre),
          priceCents: Math.max(...block.map((s) => s.priceCents)),
        });
      }
      start = end + 1;
    }
  }

  windows.sort(
    (a, b) =>
      a.sectionOrder - b.sectionOrder ||
      Number(a.strandsASeat) - Number(b.strandsASeat) ||
      a.rowInSection - b.rowInSection ||
      a.offCentre - b.offCentre ||
      a.priceCents - b.priceCents,
  );

  // Disjoint candidates: if a competing buyer takes the best block, the next one is untouched.
  const picked: number[][] = [];
  const used = new Set<number>();
  for (const w of windows) {
    if (picked.length >= limit) break;
    if (w.seatIds.some((id) => used.has(id))) continue;
    picked.push(w.seatIds);
    for (const id of w.seatIds) used.add(id);
  }
  return picked;
}
