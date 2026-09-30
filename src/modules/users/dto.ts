import { z } from 'zod';
import { USER_ROLES, type User } from '../../db/types.js';
import { Timestamp } from '../../lib/schemas.js';

export const UserDto = z
  .object({
    id: z.uuid(),
    email: z.email(),
    name: z.string(),
    role: z.enum(USER_ROLES),
    emailVerified: z.boolean().describe('Tickets are emailed, so booking needs a confirmed address'),
    createdAt: Timestamp,
  })
  .meta({ id: 'User' });

// Every response goes through an explicit DTO rather than returning rows directly, so
// columns like password_hash can never leak by accident.
export const toUserDto = (
  u: Pick<User, 'id' | 'email' | 'name' | 'role' | 'emailVerifiedAt' | 'createdAt'>,
): z.infer<typeof UserDto> => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  emailVerified: u.emailVerifiedAt !== null,
  createdAt: u.createdAt.toISOString(),
});

/** Passwords: length is what matters (NIST 800-63B). No composition rules; capped to bound hashing cost. */
export const Password = z.string().min(8, 'Use at least 8 characters').max(128);
