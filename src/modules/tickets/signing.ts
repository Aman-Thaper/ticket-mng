import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { config } from '../../config.js';

/*
 * Ticket QR codes carry a signed token: <payload>.<signature>, both base64url.
 *
 *   payload   = version (1 byte) ‖ ticket id (16 bytes) ‖ event id (16 bytes)   → 44 chars
 *   signature = Ed25519(payload)                                                 → 86 chars
 *
 * Why a signature instead of just the ticket id? A forged or mistyped code is rejected
 * without a database lookup, and nobody can mint valid-looking tickets by guessing ids.
 *
 * Why Ed25519 (asymmetric) instead of an HMAC? Door scanners only need the PUBLIC key to
 * verify tickets offline. With an HMAC, every scanner would hold the secret, and anyone who
 * extracted it from a device could forge tickets.
 *
 * Why binary UUIDs instead of JSON? A ~130-character token makes a small, easy-to-scan QR
 * code; JSON with two UUID strings would roughly double it.
 *
 * The signature proves a ticket is genuine. Whether it has already been used is a separate
 * question, answered by the database at check-in.
 */

// An Ed25519 private key in PKCS#8 DER is this fixed ASN.1 prefix followed by the 32-byte seed.
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const VERSION = 1;

const privateKey = createPrivateKey({
  key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(config.TICKET_SIGNING_KEY, 'base64')]),
  format: 'der',
  type: 'pkcs8',
});
const publicKey = createPublicKey(privateKey);

export const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
export const publicKeyJwk = publicKey.export({ format: 'jwk' });

const uuidToBytes = (uuid: string) => Buffer.from(uuid.replaceAll('-', ''), 'hex');
const bytesToUuid = (b: Buffer) => {
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

export interface TicketClaims {
  ticketId: string;
  eventId: string;
}

export function signTicket({ ticketId, eventId }: TicketClaims): string {
  const payload = Buffer.concat([Buffer.from([VERSION]), uuidToBytes(ticketId), uuidToBytes(eventId)]);
  const signature = sign(null, payload, privateKey); // Ed25519 takes no separate hash algorithm
  return `${payload.toString('base64url')}.${signature.toString('base64url')}`;
}

/** Returns the claims if the token is genuine, otherwise null. */
export function verifyTicket(token: string): TicketClaims | null {
  const parts = token.trim().split('.');
  if (parts.length !== 2) return null;
  const payload = Buffer.from(parts[0]!, 'base64url');
  const signature = Buffer.from(parts[1]!, 'base64url');
  if (payload.length !== 33 || payload[0] !== VERSION || signature.length !== 64) return null;
  if (!verify(null, payload, publicKey, signature)) return null;
  return { ticketId: bytesToUuid(payload.subarray(1, 17)), eventId: bytesToUuid(payload.subarray(17, 33)) };
}
