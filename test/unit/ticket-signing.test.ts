import { createPublicKey, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { publicKeyPem, signTicket, verifyTicket } from '../../src/modules/tickets/signing.js';

const claims = {
  ticketId: '6f1c7f59-4a8e-4c7e-9a0b-0b7d1c2e3f40',
  eventId: '0b9d6a44-2c1e-4a53-8f0e-7d9a1b2c3d4e',
};

describe('ticket signing', () => {
  it('round-trips and stays compact enough for a small QR code', () => {
    const token = signTicket(claims);
    expect(verifyTicket(token)).toEqual(claims);
    expect(token.length).toBeLessThan(140);
  });

  it('rejects any modification of the payload', () => {
    const [payload, sig] = signTicket(claims).split('.') as [string, string];
    const bytes = Buffer.from(payload, 'base64url');
    bytes[5] = bytes[5]! ^ 0xff; // flip bits inside the ticket id
    expect(verifyTicket(`${bytes.toString('base64url')}.${sig}`)).toBeNull();
  });

  it('rejects a signature from another ticket, and malformed input', () => {
    const [payloadA] = signTicket(claims).split('.') as [string];
    const [, sigB] = signTicket({ ...claims, ticketId: '11111111-1111-4111-8111-111111111111' }).split(
      '.',
    ) as [string, string];
    expect(verifyTicket(`${payloadA}.${sigB}`)).toBeNull();
    for (const bad of ['', 'abc', 'a.b.c', `${payloadA}.`, `.${sigB}`]) expect(verifyTicket(bad)).toBeNull();
  });

  it('verifies with nothing but the published public key (what an offline scanner does)', () => {
    const [payload, sig] = signTicket(claims).split('.') as [string, string];
    const key = createPublicKey(publicKeyPem);
    expect(verify(null, Buffer.from(payload, 'base64url'), key, Buffer.from(sig, 'base64url'))).toBe(true);
  });
});
