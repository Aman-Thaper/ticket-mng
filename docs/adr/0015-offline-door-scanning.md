# 0015. Door scanning works offline: verify on the device, admit, reconcile later

**Status:** accepted

## Context

Venue entrances are where networks fail: thick walls, thousands of phones on the same towers, sometimes no Wi-Fi. A scanner that needs the server for every ticket stops the queue whenever the signal drops, and a queue of thousands can't wait.

Two different questions are asked at the door:

1. **Is this a genuine ticket for this show?** Answerable from the ticket alone: it's signed (Ed25519; the reasoning is in `src/modules/tickets/signing.ts`) and names its event.
2. **Has it been used already?** Only the server knows for sure, because any door could have scanned it.

## Decision

- **Question 1 is answered on the device, always.** The scanner keeps the public key (from `GET /tickets/public-key`) and verifies signatures with WebCrypto. Forgeries, garbage and tickets for other events are rejected instantly, online or not.
- **Question 2 goes to the server when it can.** Online, `POST /check-in` admits each ticket exactly once (one conditional `UPDATE`).
- **With no signal, a genuine ticket is admitted provisionally.** The scan is stored in IndexedDB with its time. Repeats on the same device are caught there. When the connection returns, queued scans are sent with `scannedAt`; whatever the server refuses (used at another door, refunded) is listed on the scanner for staff to follow up.
- **Offline check-ins outlive logout** until they've synced: dropping them would lose the record of who came in.
- **Attendance numbers are polled** (every 3 s, cached for 1 s, with ETags) rather than pushed over a WebSocket.

## Consequences

- The line keeps moving through a network outage, and fake tickets are still stopped.
- A ticket shown at two different doors that are both offline gets in twice. The second sync reports it, with the times. That's the price of availability. The alternative, refusing everyone until the network comes back, is worse for a real event.
- Attendance during an outage is complete only per device; it becomes exact once every device has synced, with true scan times.
- The phone never holds anything that can create tickets: the private key stays on the server.

## Alternatives considered

- **Online only:** simplest and exactly-once, but an outage stops the doors.
- **Download the guest list to each scanner** (valid ticket ids): could also reject refunded tickets offline, but it's a list of attendees on every staff phone, it goes stale as people buy and refund, and devices still can't see each other's scans. Signatures give the important half without either cost.
- **Scanners talking to each other on the local network:** would catch cross-door duplicates offline, but needs peer discovery and a shared network, which is exactly what's missing.
- **WebSockets for live attendance:** the audience is a few organizer screens, browsers can't send auth headers on WebSockets, and a 3 s poll against a 1 s cache is cheap. Seat maps, with thousands of viewers, are where push pays off (ADR 0007).
