import { createHash, randomBytes } from 'node:crypto';
import { errors as joseErrors, jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';
import { config } from '../../config.js';
import { USER_ROLES, type UserRole } from '../../db/types.js';
import { unauthorized } from '../../lib/errors.js';

const ISSUER = 'ticket-mng';
const AUDIENCE = 'ticket-mng-api';

// The current key signs. The previous key (if set) is still accepted for verification, which
// allows rotating the secret without logging everyone out: deploy with both, wait one
// access-token lifetime, then drop the old one.
const keys = [config.JWT_ACCESS_SECRET, config.JWT_ACCESS_SECRET_PREVIOUS]
  .filter((k): k is string => Boolean(k))
  .map((k) => new TextEncoder().encode(k));

export interface AccessClaims {
  /** user id */
  sub: string;
  /** session id: lets a revoked session's tokens be rejected before they expire */
  sid: string;
  role: UserRole;
}

const Claims = z.object({ sub: z.uuid(), sid: z.uuid(), role: z.enum(USER_ROLES) });

export function signAccessToken(claims: AccessClaims): Promise<string> {
  return new SignJWT({ sid: claims.sid, role: claims.role })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${config.ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(keys[0]!);
}

export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  for (const key of keys) {
    try {
      // Pinning `algorithms` is what defeats "alg: none" and algorithm-confusion attacks:
      // the token's header never gets to choose how it is verified.
      const { payload } = await jwtVerify(token, key, {
        algorithms: ['HS256'],
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      const claims = Claims.safeParse(payload);
      if (!claims.success) break;
      return claims.data;
    } catch (err) {
      if (err instanceof joseErrors.JWSSignatureVerificationFailed) continue; // try the next key
      if (err instanceof joseErrors.JWTExpired) {
        throw unauthorized('TOKEN_EXPIRED', 'Access token has expired; refresh it');
      }
      break;
    }
  }
  throw unauthorized('INVALID_TOKEN', 'Access token is invalid');
}

/** 256 bits of randomness, URL-safe. Used for refresh and password-reset tokens. */
export const newOpaqueToken = () => randomBytes(32).toString('base64url');

/** What gets stored instead of the token itself. */
export const hashToken = (token: string) => createHash('sha256').update(token).digest();
