import type { ColumnType, Generated, Selectable } from 'kysely';

// Property names are camelCase; the CamelCasePlugin maps them to snake_case columns.

export const USER_ROLES = ['attendee', 'organizer', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const EVENT_STATUSES = ['draft', 'published', 'cancelled'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export const EVENT_CATEGORIES = ['concert', 'theatre', 'comedy', 'sports', 'festival', 'other'] as const;
export type EventCategory = (typeof EVENT_CATEGORIES)[number];

export const SEAT_STATUSES = ['available', 'held', 'booked'] as const;
export type SeatStatus = (typeof SEAT_STATUSES)[number];

export const BOOKING_STATUSES = ['pending', 'confirmed', 'expired', 'cancelled', 'refunded'] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export const TICKET_STATUSES = ['valid', 'void'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const POSTER_STATUSES = ['processing', 'ready', 'failed'] as const;
export type PosterStatus = (typeof POSTER_STATUSES)[number];

/** Poster width (px) → object key of the resized WebP. */
export type PosterVariants = Record<string, string>;

type CreatedAt = ColumnType<Date, never, never>;
type UpdatedAt = ColumnType<Date, never, never>; // maintained by a trigger

export interface UsersTable {
  id: Generated<string>;
  email: string;
  name: string;
  role: Generated<UserRole>;
  passwordHash: string | null;
  passwordChangedAt: Date | null;
  createdAt: CreatedAt;
  updatedAt: UpdatedAt;
}

export interface SessionsTable {
  id: Generated<string>;
  userId: string;
  createdAt: CreatedAt;
  lastUsedAt: Generated<Date>;
  expiresAt: Date;
  revokedAt: Date | null;
  revokeReason: string | null;
  userAgent: string | null;
  ip: string | null;
}

export interface RefreshTokensTable {
  id: Generated<string>;
  sessionId: string;
  tokenHash: Buffer;
  createdAt: CreatedAt;
  expiresAt: Date;
  usedAt: Date | null;
}

export interface PasswordResetTokensTable {
  id: Generated<string>;
  userId: string;
  tokenHash: Buffer;
  createdAt: CreatedAt;
  expiresAt: Date;
  usedAt: Date | null;
}

export interface VenuesTable {
  id: Generated<string>;
  name: string;
  address: string;
  city: string;
  country: string;
  capacity: number;
  createdAt: CreatedAt;
  updatedAt: UpdatedAt;
}

export interface VenueSectionsTable {
  id: Generated<string>;
  venueId: string;
  name: string;
  sortOrder: number;
}

export interface VenueSeatsTable {
  id: Generated<number>;
  sectionId: string;
  rowLabel: string;
  seatNumber: number;
  x: number;
  y: number;
}

export interface EventsTable {
  id: Generated<string>;
  organizerId: string;
  venueId: string;
  title: string;
  description: Generated<string>;
  category: EventCategory;
  status: Generated<EventStatus>;
  startsAt: Date;
  endsAt: Date;
  salesStartAt: Date | null;
  maxTicketsPerUser: Generated<number>;
  currency: Generated<string>;
  posterStatus: PosterStatus | null;
  posterKey: string | null;
  posterVariants: ColumnType<PosterVariants | null, string | null, string | null>;
  posterError: string | null;
  createdAt: CreatedAt;
  updatedAt: UpdatedAt;
}

export interface EventSeatsTable {
  id: Generated<number>;
  eventId: string;
  venueSeatId: number;
  priceCents: number;
  status: Generated<SeatStatus>;
  bookingId: string | null;
  version: Generated<number>;
}

export interface BookingsTable {
  id: Generated<string>;
  userId: string;
  eventId: string;
  status: Generated<BookingStatus>;
  totalCents: number;
  currency: string;
  expiresAt: Date;
  confirmedAt: Date | null;
  expiredAt: Date | null;
  cancelledAt: Date | null;
  refundedAt: Date | null;
  createdAt: CreatedAt;
  updatedAt: UpdatedAt;
}

export interface BookingItemsTable {
  bookingId: string;
  eventSeatId: number;
  priceCents: number;
}

export interface TicketsTable {
  id: Generated<string>;
  bookingId: string;
  eventId: string;
  eventSeatId: number;
  status: Generated<TicketStatus>;
  checkedInAt: Date | null;
  checkedInBy: string | null;
  voidedAt: Date | null;
  createdAt: CreatedAt;
}

export interface OutboxTable {
  id: Generated<number>;
  queue: string;
  jobName: string;
  // jsonb: inserted as a JSON string, read back as parsed JSON.
  payload: ColumnType<Record<string, unknown>, string, string>;
  jobId: string | null;
  runAt: Generated<Date>;
  requestId: string | null;
  createdAt: CreatedAt;
  publishedAt: Date | null;
}

export interface NotificationsTable {
  kind: string;
  refId: string;
  userId: string | null;
  status: Generated<'sending' | 'sent'>;
  createdAt: CreatedAt;
  sentAt: Date | null;
}

export interface DB {
  users: UsersTable;
  sessions: SessionsTable;
  refreshTokens: RefreshTokensTable;
  passwordResetTokens: PasswordResetTokensTable;
  venues: VenuesTable;
  venueSections: VenueSectionsTable;
  venueSeats: VenueSeatsTable;
  events: EventsTable;
  eventSeats: EventSeatsTable;
  bookings: BookingsTable;
  bookingItems: BookingItemsTable;
  tickets: TicketsTable;
  outbox: OutboxTable;
  notifications: NotificationsTable;
}

export type User = Selectable<UsersTable>;
export type Venue = Selectable<VenuesTable>;
export type Event = Selectable<EventsTable>;
export type Booking = Selectable<BookingsTable>;
