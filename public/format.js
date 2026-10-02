// Display helpers shared by the catalog, event and ticket pages.

export const CATEGORIES = [
  {
    id: 'concert',
    label: 'Concerts',
    single: 'Concert',
    icon: '🎤',
    icons: ['🎤', '🎸', '🎹', '🎷', '🥁', '🎻', '🎺'],
    hue: 275,
  },
  {
    id: 'theatre',
    label: 'Theatre',
    single: 'Theatre',
    icon: '🎭',
    icons: ['🎭', '🩰', '🎬', '📜'],
    hue: 350,
  },
  { id: 'comedy', label: 'Comedy', single: 'Comedy', icon: '🎙️', icons: ['🎙️', '😂', '🤡', '🎤'], hue: 32 },
  {
    id: 'sports',
    label: 'Sports',
    single: 'Sports',
    icon: '🏟️',
    icons: ['⚽', '🏀', '🏈', '🏏', '🎾', '🏒'],
    hue: 150,
  },
  {
    id: 'festival',
    label: 'Festivals',
    single: 'Festival',
    icon: '🎪',
    icons: ['🎪', '🎡', '🎆', '🎶', '🌅'],
    hue: 315,
  },
  {
    id: 'other',
    label: 'More events',
    single: 'Event',
    icon: '✨',
    icons: ['✨', '🍷', '🔬', '🎧', '🪄', '🎞️'],
    hue: 215,
  },
];

export const categoryOf = (id) => CATEGORIES.find((c) => c.id === id) ?? CATEGORIES.at(-1);

export const money = (cents, currency = 'USD') =>
  new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    maximumFractionDigits: cents % 100 ? 2 : 0,
  }).format(cents / 100);

// Event times are shown in the venue's time zone: a 7:30 PM show in Toronto reads 7:30 PM
// whoever is looking, as on a printed ticket. (Stored as UTC instants; see migration 0009.)
const DAY = { weekday: 'short', month: 'short', day: 'numeric' };
const TIME = { hour: 'numeric', minute: '2-digit' };
const FULL = { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' };

const formatters = new Map();
function format(iso, timeZone, options) {
  const key = `${timeZone}|${JSON.stringify(options)}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(undefined, { ...options, timeZone });
    formatters.set(key, formatter);
  }
  return formatter.format(new Date(iso));
}

/** "Sat, Oct 5 · 7:30 PM", in the venue's time zone. */
export const when = (iso, timeZone) => `${format(iso, timeZone, DAY)} · ${format(iso, timeZone, TIME)}`;
export const longDate = (iso, timeZone) => format(iso, timeZone, FULL);
export const time = (iso, timeZone) => format(iso, timeZone, TIME);

/** Month and day for the date badge on a card. */
export function dateBadge(iso, timeZone) {
  return {
    month: format(iso, timeZone, { month: 'short' }).toUpperCase(),
    day: format(iso, timeZone, { day: 'numeric' }),
  };
}

const hashOf = (id) => {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(hash);
};

/** A stable hue for an event's artwork: its category's colour, shifted per event. */
export const eventHue = (id, category) => categoryOf(category).hue + (hashOf(id) % 70) - 35;

/** A stable icon for an event's artwork, from its category's set. */
export function eventIcon(id, category) {
  const { icons } = categoryOf(category);
  return icons[hashOf(id) % icons.length];
}

/** How a card describes availability, or null when there's plenty left. */
export function availabilityTag(seats) {
  if (!seats?.total) return { text: 'Not on sale', tone: 'muted' };
  if (seats.available === 0) return { text: 'Sold out', tone: 'danger' };
  const left = seats.available / seats.total;
  if (left < 0.2) return { text: 'Almost sold out', tone: 'warning' };
  if (left < 0.5) return { text: 'Selling fast', tone: 'hot' };
  return null;
}

/** "From $20" or "$20–$120", from an event's price range. */
export function priceText(range, currency) {
  if (!range) return '';
  return range.minCents === range.maxCents
    ? money(range.minCents, currency)
    : `From ${money(range.minCents, currency)}`;
}

const counts = new Intl.NumberFormat();
const compactCounts = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

/** "1,240" */
export const count = (n) => counts.format(n);
/** "1.2K" */
export const compactCount = (n) => compactCounts.format(n);

/**
 * "1,240 viewing now · 86 sold in the last hour", from an event's live numbers, or '' when
 * there's nothing worth saying. One viewer is just you, so viewers start counting at two.
 */
export function liveText(live) {
  const parts = [];
  if (live?.viewers >= 2) parts.push(`${count(live.viewers)} viewing now`);
  if (live?.soldLastHour > 0) parts.push(`${count(live.soldLastHour)} sold in the last hour`);
  return parts.join(' · ');
}
