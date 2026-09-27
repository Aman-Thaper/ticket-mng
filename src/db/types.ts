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

type CreatedAt = ColumnType<Date, never, never>;
type UpdatedAt = ColumnType<Date, never, never>; // maintained by a trigger

export interface UsersTable {
  id: Generated<string>;
  email: string;
  name: string;
  role: Generated<UserRole>;
  createdAt: CreatedAt;
  updatedAt: UpdatedAt;
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
  currency: Generated<string>;
  createdAt: CreatedAt;
  updatedAt: UpdatedAt;
}

export interface EventSeatsTable {
  id: Generated<number>;
  eventId: string;
  venueSeatId: number;
  priceCents: number;
  status: Generated<SeatStatus>;
}

export interface DB {
  users: UsersTable;
  venues: VenuesTable;
  venueSections: VenueSectionsTable;
  venueSeats: VenueSeatsTable;
  events: EventsTable;
  eventSeats: EventSeatsTable;
}

export type User = Selectable<UsersTable>;
export type Venue = Selectable<VenuesTable>;
export type Event = Selectable<EventsTable>;
