<div class="cover">
<div class="cover-kicker">A beginner's guide to</div>
<h1 class="cover-title">ticket-mng</h1>
<div class="cover-sub">How a real, production-style backend is put together,<br>explained one file at a time</div>
<div class="cover-meta">Node.js · TypeScript · Fastify · PostgreSQL · Redis · BullMQ · WebSockets · Docker</div>
</div>

<div class="toc-page" markdown="1">

# Contents

1. [How to use this guide](#how-to-use-this-guide)
2. [What the app does, in plain words](#what-the-app-does-in-plain-words)
3. [Words you need first](#words-you-need-first)
4. [The tools (the stack) and why each one is there](#the-tools-the-stack-and-why-each-one-is-there)
5. [A tour of the folders](#a-tour-of-the-folders)
6. [How the program starts](#how-the-program-starts)
7. [The database: tables, migrations, queries, transactions](#the-database-tables-migrations-queries-transactions)
8. [The journey of one request](#the-journey-of-one-request)
9. [Validation and errors](#validation-and-errors)
10. [Authentication: who are you?](#authentication-who-are-you)
11. [Venues and events](#venues-and-events)
12. [Bookings: the hardest part](#bookings-the-hardest-part)
13. [Background jobs and the outbox](#background-jobs-and-the-outbox)
14. [Payments and webhooks](#payments-and-webhooks)
15. [Tickets and check-in](#tickets-and-check-in)
16. [Posters: uploading files](#posters-uploading-files)
17. [Live seat maps (WebSockets)](#live-seat-maps-websockets)
18. [The browser page (public/app.js)](#the-browser-page-publicappjs)
19. [Staying fast under load](#staying-fast-under-load)
20. [Logs, metrics, health checks, shutdown](#logs-metrics-health-checks-shutdown)
21. [Docker, Nginx, CI and deploying](#docker-nginx-ci-and-deploying)
22. [Tests](#tests)
23. [Trace one purchase from start to finish](#trace-one-purchase-from-start-to-finish)
24. [How to build your own project](#how-to-build-your-own-project)
25. [Glossary](#glossary)

</div>

# How to use this guide

You said you know programming languages but have never built a big project. That is exactly the gap this guide fills. Knowing a language means you can write a function. Building a project means knowing **how many pieces connect**: a web server, a database, a cache, background workers, a browser page, and the glue between them.

This guide walks through **ticket-mng**, an event-ticketing backend (think a mini Ticketmaster). It is a very good project to learn from because it solves real, hard problems: two people clicking the same seat at the same millisecond, payments that arrive late, emails that must be sent exactly once, thousands of people watching one seat map.

**How it is organised**

- Chapters 2 to 5 give you the **big picture**: what the app does, the vocabulary, the tools, the folders.
- Chapters 6 to 9 explain the **skeleton** every backend has: startup, database, request handling, errors.
- Chapters 10 to 18 go **feature by feature**, showing the real code with line-by-line explanations.
- Chapters 19 to 22 cover **running it for real**: speed, monitoring, Docker, tests.
- Chapters 23 and 24 tie it together and show you **how to start your own project**.

**How to read the code boxes.** Code is copied from the repository (sometimes shortened with `// ...`). Right after each box you will find an explanation. File paths are written like `src/app.ts`, so you can open the same file and follow along.

<div class="tip"><b>Tip.</b> Keep the project open in your editor while you read. When the guide says "open <code>src/db/transaction.ts</code>", actually open it. Reading real files is how this knowledge sticks.</div>

<div class="note"><b>You do not need to understand everything on the first read.</b> Some chapters (bookings, payments) are hard even for experienced developers. Read for the idea first; come back for the details later.</div>

# What the app does, in plain words

Imagine a concert hall. The app lets people:

1. **Sign up and log in** (as an *attendee* who buys tickets, or an *organizer* who creates events; there is also an *admin*).
2. An organizer **creates a venue** ("City Hall, 3 sections, 20 rows each, 30 seats per row"). The app generates every seat with a row letter, number and x/y position for drawing.
3. The organizer **creates an event** at that venue ("Rock Night, Friday 8pm"), sets a price per section and **publishes** it.
4. A buyer **opens the seat map**, sees which seats are free, and **holds** some seats. A hold reserves the seats for 10 minutes.
5. The buyer **pays** (with a fake card in development, or Stripe). When the payment succeeds, the booking becomes **confirmed**.
6. The buyer gets an **email with QR-code tickets**.
7. At the door, staff **scan the QR code** (check-in). Each ticket admits exactly once.
8. Meanwhile, everyone else watching the seat map **sees seats turn red live**, without refreshing.

Behind that simple story are the hard problems the project is really about:

| Problem | Where it is solved |
|---|---|
| 200 people click the same seat at once; exactly one must win | Chapter 12 (bookings) |
| A hold must expire after 10 minutes even if a server crashes | Chapter 12 (lazy expiry) |
| An email must be sent once, and only if the booking really saved | Chapter 13 (outbox) |
| Payment messages arrive twice, late, or out of order | Chapter 14 (reconcile) |
| Thousands watch one seat map | Chapters 17 and 19 |
| Deploying new code must not drop a single request | Chapter 21 |

# Words you need first

If any of these are new, read this chapter slowly. Everything later builds on them.

**Client and server.** The *client* asks, the *server* answers. Your browser is a client. `ticket-mng` is a server. A phone app, a script, or another server can also be a client.

**HTTP.** The language clients and servers use on the web. A request has a **method** (what to do), a **path** (what to do it to), **headers** (extra info, like who you are) and sometimes a **body** (data). The response has a **status code** and usually a body.

| Method | Meaning | Example in this app |
|---|---|---|
| `GET` | read something | `GET /api/v1/events` lists events |
| `POST` | create / do something | `POST /api/v1/auth/login` logs in |
| `PATCH` | change part of something | `PATCH /api/v1/events/:id` edits an event |
| `DELETE` | remove something | `DELETE /api/v1/events/:id` deletes a draft |

Status codes you will see: `200` OK, `201` Created, `204` No Content, `400` bad input, `401` not logged in, `403` logged in but not allowed, `404` not found, `409` conflict (for example the seat is taken), `422` input makes no sense, `429` too many requests, `500` server bug, `503` server busy, try again.

**API.** "Application Programming Interface": the list of requests a server accepts. This app's API is all under `/api/v1/...` (the `v1` means "version 1", so a future `v2` can change things without breaking old clients).

**JSON.** The text format for data: `{"email": "a@b.com", "seatIds": [12, 13]}`. Almost every request and response body in this app is JSON.

**Route / endpoint.** One method + path the server handles, like `POST /api/v1/events/:id/bookings`. `:id` is a *parameter*: a placeholder filled by the real id.

**Handler.** The function that runs for a route.

**Database.** Where data is stored permanently. This app uses **PostgreSQL**, a *relational* database: data lives in **tables** (like spreadsheets) with **rows** and **columns**. You talk to it using **SQL** (`SELECT`, `INSERT`, `UPDATE`, `DELETE`).

**Transaction.** A group of database changes that happen *all together or not at all*. If anything fails halfway, the database undoes (rolls back) everything. Saving money-related data without transactions is how bugs lose money.

**Cache.** A fast, temporary copy of data so you do not have to recompute or re-query it every time. This app uses **Redis** (an in-memory data store) and plain in-memory JavaScript maps as caches.

**Queue / job / worker.** Some work is slow (sending email, resizing an image) or must happen later (expire a hold in 10 minutes). Instead of doing it during the request, the app puts a *job* on a *queue*, and a separate *worker* process picks it up.

**Process.** A running program. This project runs *several* processes from the *same code*: the **API server** (answers HTTP), the **worker** (runs jobs), and a **migration** command (updates the database structure).

**Concurrency / race condition.** Many things happening at the same time. A *race condition* is a bug that happens only when two things interleave in an unlucky order, for example two requests both reading "seat is free" before either writes "seat is taken".

**Environment variables.** Settings passed to a program from outside (like `DATABASE_URL=postgres://...`), so the same code runs on your laptop and in production with different settings.

**Container (Docker).** A packaged, isolated box containing your program and everything it needs, so it runs the same everywhere.

**WebSocket.** A connection that stays open so the server can *push* messages to the browser (used for live seat updates). Normal HTTP is "ask, get one answer, done".

