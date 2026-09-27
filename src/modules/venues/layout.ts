export interface SectionSpec {
  name: string;
  rows: number;
  seatsPerRow: number;
}

export interface GeneratedSeat {
  section: string;
  rowLabel: string;
  seatNumber: number;
  x: number;
  y: number;
}

/** Empty grid rows between sections on the seat map. */
const SECTION_GAP = 2;

/** 0 → A, 25 → Z, 26 → AA, 27 → AB, … (spreadsheet-style row labels). */
export function rowLabel(index: number): string {
  let label = '';
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    label = String.fromCharCode(65 + rem) + label;
    n = Math.floor((n - 1) / 26);
  }
  return label;
}

/**
 * Turns a compact section spec into individual seats with grid coordinates. Sections stack
 * top to bottom, and each is centered horizontally against the widest section.
 */
export function generateSeats(sections: SectionSpec[]): GeneratedSeat[] {
  const maxWidth = Math.max(...sections.map((s) => s.seatsPerRow));
  const seats: GeneratedSeat[] = [];
  let y = 0;

  for (const section of sections) {
    const xOffset = Math.floor((maxWidth - section.seatsPerRow) / 2);
    for (let r = 0; r < section.rows; r++) {
      const label = rowLabel(r);
      for (let n = 1; n <= section.seatsPerRow; n++) {
        seats.push({ section: section.name, rowLabel: label, seatNumber: n, x: xOffset + n - 1, y });
      }
      y++;
    }
    y += SECTION_GAP;
  }
  return seats;
}
