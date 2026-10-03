// A bar chart in plain SVG: tickets sold over time on the organizer dashboard. Bars sit at
// their real times (an hour with no sales is a gap, not a missing bar), and every bar has a
// tooltip. About 80 lines instead of a charting library.

const SVG_NS = 'http://www.w3.org/2000/svg';
const WIDTH = 640;
const HEIGHT = 220;
const PAD = { top: 12, right: 12, bottom: 28, left: 40 };

const node = (tag, attrs = {}, text) => {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  if (text !== undefined) el.textContent = text;
  return el;
};

/** 0, a round step, …, at least `max`: e.g. max 37 → [0, 10, 20, 30, 40]. Counts: whole steps. */
function ticks(max) {
  if (max <= 0) return [0, 1];
  const rough = Math.max(1, max / 4);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= rough);
  return Array.from({ length: Math.ceil(max / step) + 1 }, (_, i) => i * step);
}

/**
 * points: [{ at (ISO), value }]; bucketMs: the width of one bar in time.
 * label(point) → the bar's tooltip; timeLabel(date) → an x-axis label.
 */
export function drawBarChart(svg, points, { bucketMs, label, timeLabel, emptyText = 'No sales yet' }) {
  svg.replaceChildren();
  svg.setAttribute('viewBox', `0 0 ${WIDTH} ${HEIGHT}`);
  const plotW = WIDTH - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;

  if (!points.length) {
    svg.append(
      node('text', { x: WIDTH / 2, y: HEIGHT / 2, class: 'chart-empty', 'text-anchor': 'middle' }, emptyText),
    );
    return;
  }

  const times = points.map((p) => Date.parse(p.at));
  const start = Math.min(...times);
  // At least a dozen buckets wide, so a single bar doesn't fill the whole chart.
  const end = Math.max(Math.max(...times) + bucketMs, start + 12 * bucketMs);
  const x = (t) => PAD.left + ((t - start) / (end - start)) * plotW;
  const yTicks = ticks(Math.max(...points.map((p) => p.value)));
  const top = yTicks.at(-1);
  const y = (v) => PAD.top + plotH - (v / top) * plotH;

  for (const t of yTicks) {
    svg.append(
      node('line', { x1: PAD.left, x2: WIDTH - PAD.right, y1: y(t), y2: y(t), class: 'chart-grid' }),
    );
    svg.append(
      node(
        'text',
        { x: PAD.left - 6, y: y(t) + 4, class: 'chart-axis', 'text-anchor': 'end' },
        t.toLocaleString(),
      ),
    );
  }

  const barW = Math.max(2, (bucketMs / (end - start)) * plotW - 2);
  points.forEach((p, i) => {
    const bar = node('rect', {
      x: x(times[i]) + 1,
      y: y(p.value),
      width: barW,
      height: Math.max(1, PAD.top + plotH - y(p.value)),
      rx: 2,
      class: 'chart-bar',
    });
    bar.append(node('title', {}, label(p)));
    svg.append(bar);
  });

  // Four time labels, evenly spread.
  for (let i = 0; i <= 3; i++) {
    const t = start + ((end - start) * i) / 3;
    const anchor = i === 0 ? 'start' : i === 3 ? 'end' : 'middle';
    svg.append(
      node(
        'text',
        { x: x(t), y: HEIGHT - 8, class: 'chart-axis', 'text-anchor': anchor },
        timeLabel(new Date(t)),
      ),
    );
  }
}
