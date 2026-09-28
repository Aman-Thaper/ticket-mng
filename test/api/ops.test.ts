import { describe, expect, it } from 'vitest';
import { lifecycle } from '../../src/lib/lifecycle.js';
import { createUser, useApp } from '../helpers.js';

describe('operations', () => {
  const t = useApp();

  it('liveness answers without touching dependencies; readiness checks them', async () => {
    expect((await t.app.inject({ url: '/health/live' })).json()).toEqual({ status: 'ok' });
    const ready = await t.app.inject({ url: '/health/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: 'ok', checks: { database: 'ok', redis: 'ok', lifecycle: 'ok' } });
  });

  it('propagates a well-formed X-Request-Id and replaces a malformed one', async () => {
    const kept = await t.app.inject({ url: '/health/live', headers: { 'x-request-id': 'trace-abc-123' } });
    expect(kept.headers['x-request-id']).toBe('trace-abc-123');
    const replaced = await t.app.inject({
      url: '/health/live',
      headers: { 'x-request-id': 'evil\nlog line' },
    });
    expect(replaced.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('exposes Prometheus metrics, labelled by route template (not raw URL)', async () => {
    const user = await createUser('attendee');
    await t.app.inject({ url: '/api/v1/users/me', headers: user.auth });
    const metrics = await t.app.inject({ url: '/metrics' });
    expect(metrics.headers['content-type']).toContain('text/plain');
    expect(metrics.body).toContain(
      'http_request_duration_seconds_count{method="GET",route="/api/v1/users/me",status_code="200"}',
    );
    expect(metrics.body).toMatch(/db_pool_connections\{state="waiting"\} \d+/);
    expect(metrics.body).toContain('nodejs_eventloop_lag_p99_seconds');
  });

  // Last in the file on purpose: shutdown is one-way, and each test file gets fresh modules.
  it('reports not-ready during shutdown, so load balancers drain the instance first', async () => {
    lifecycle.beginShutdown();
    const ready = await t.app.inject({ url: '/health/ready' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json().checks.lifecycle).toBe('shutting down');
    expect((await t.app.inject({ url: '/health/live' })).statusCode).toBe(200); // still alive
  });
});
