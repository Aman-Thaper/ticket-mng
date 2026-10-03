// Drawing a seat map: one label per section, one square per seat, on the venue's grid
// (x along a row, y down the venue; see src/modules/venues/layout.ts). The event page makes
// the squares clickable; the organizer dashboard colours them by status, live.

const SVG_NS = 'http://www.w3.org/2000/svg';
const CELL = 18; // grid pitch in px
const SEAT = 14; // seat size in px
const LABEL_WIDTH = 90;

/**
 * Draw `map` (GET /events/:id/seats) into `svg`, replacing what was there. decorate(rect, seat,
 * section) adds what the page needs: classes, labels, handlers.
 */
export function drawSeatGrid(svg, map, decorate) {
  svg.replaceChildren();
  let maxX = 0;
  let maxY = 0;
  for (const section of map.sections) {
    const top = Math.min(...section.seats.map((s) => s.y));
    const title = document.createElementNS(SVG_NS, 'text');
    title.setAttribute('x', '0');
    title.setAttribute('y', String(top * CELL + SEAT - 2));
    title.setAttribute('class', 'section-label');
    title.textContent = section.name;
    svg.append(title);

    for (const seat of section.seats) {
      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('x', String(LABEL_WIDTH + seat.x * CELL));
      rect.setAttribute('y', String(seat.y * CELL));
      rect.setAttribute('width', String(SEAT));
      rect.setAttribute('height', String(SEAT));
      rect.setAttribute('rx', '3');
      decorate(rect, seat, section);
      svg.append(rect);
      maxX = Math.max(maxX, seat.x);
      maxY = Math.max(maxY, seat.y);
    }
  }
  const width = LABEL_WIDTH + (maxX + 1) * CELL;
  const height = (maxY + 1) * CELL;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
}
