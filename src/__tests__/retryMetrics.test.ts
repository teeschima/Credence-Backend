/**
 * Tests for per-provider retry observability (issue #248).
 *
 * Covers:
 * - RetryObserver hooks fired by SorobanClient on retry, exhaustion, and success
 * - noopRetryObserver is safe to use (no-op, no throws)
 * - createPrometheusRetryObserver falls back to noop when prom-client is absent
 * - _resetPrometheusObserverCache allows isolated test runs
 */

import assert from 'node:assert/strict'
import { describe, it, beforeEach } from 'vitest'

import { SorobanClient } from '../clients/soroban.js'
import {
  noopRetryObserver,
  createPrometheusRetryObserver,
  _resetPrometheusObserverCache,
  type RetryObserver,
  type RetryAttemptEvent,
  type RetryExhaustedEvent,
  type RetrySuccessEvent,
} from '../observability/retryMetrics.js'

const baseConfig = {
  rpcUrl: 'https://rpc.testnet.stellar.org',
  network: 'testnet' as const,
  contractId: 'CDUMMYCONTRACTID',
  retry: {
    maxAttempts: 3,
    baseDelayMs: 1,
    backoffMultiplier: 2,
    maxDelayMs: 10,
  },
}

// ---------------------------------------------------------------------------
// Spy observer factory
// ---------------------------------------------------------------------------

function makeSpyObserver() {
  const attempts: RetryAttemptEvent[] = []
  const exhausted: RetryExhaustedEvent[] = []
  const successes: RetrySuccessEvent[] = []

  const observer: RetryObserver = {
    onRetryAttempt: (e) => attempts.push(e),
    onRetryExhausted: (e) => exhausted.push(e),
    onSuccess: (e) => successes.push(e),
  }

  return { observer, attempts, exhausted, successes }
}

// ---------------------------------------------------------------------------
// SorobanClient observer integration
// ---------------------------------------------------------------------------

describe('SorobanClient retry observer', () => {
  it('fires onSuccess with attempt=1 when first call succeeds', async () => {
    const { observer, successes } = makeSpyObserver()

    const client = new SorobanClient(baseConfig, {
      fetchFn: async () =>
        new Response(
          JSON.stringify({ jsonrpc: '2.0', id: '1', result: { events: [] } }),
          { status: 200 },
        ),
      retryObserver: observer,
    })

    await client.getContractEvents()

    assert.equal(successes.length, 1)
    assert.equal(successes[0]?.provider, 'soroban')
    assert.equal(successes[0]?.attempt, 1)
    assert.ok(typeof successes[0]?.durationMs === 'number')
  })

  it('fires onRetryAttempt for each failed attempt before success', async () => {
    const { observer, attempts, successes } = makeSpyObserver()
    let call = 0

    const client = new SorobanClient(baseConfig, {
      fetchFn: async () => {
        call += 1
        if (call < 3) return new Response('unavailable', { status: 503 })
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 'ok', result: { events: [] } }),
          { status: 200 },
        )
      },
      sleepFn: async () => {},
      retryObserver: observer,
    })

    await client.getContractEvents()

    assert.equal(attempts.length, 2)
    assert.equal(attempts[0]?.provider, 'soroban')
    assert.equal(attempts[0]?.attempt, 1)
    assert.equal(attempts[0]?.errorCode, 'HTTP_ERROR')
    assert.ok(typeof attempts[0]?.delayMs === 'number')

    assert.equal(attempts[1]?.attempt, 2)

    assert.equal(successes.length, 1)
    assert.equal(successes[0]?.attempt, 3)
  })

  it('fires onRetryExhausted when all attempts fail', async () => {
    const { observer, attempts, exhausted, successes } = makeSpyObserver()

    const client = new SorobanClient(baseConfig, {
      fetchFn: async () => new Response('unavailable', { status: 503 }),
      sleepFn: async () => {},
      retryObserver: observer,
    })

    await assert.rejects(client.getContractEvents())

    assert.equal(attempts.length, 2) // attempts 1 and 2 trigger retry; attempt 3 exhausts
    assert.equal(exhausted.length, 1)
    assert.equal(exhausted[0]?.provider, 'soroban')
    assert.equal(exhausted[0]?.attempts, 3)
    assert.equal(exhausted[0]?.errorCode, 'HTTP_ERROR')
    assert.equal(successes.length, 0)
  })

  it('fires onRetryExhausted immediately for non-retryable errors (no retry)', async () => {
    const { observer, attempts, exhausted } = makeSpyObserver()

    const client = new SorobanClient(baseConfig, {
      fetchFn: async () => new Response('bad request', { status: 400 }),
      retryObserver: observer,
    })

    await assert.rejects(client.getContractEvents())

    assert.equal(attempts.length, 0)
    assert.equal(exhausted.length, 1)
    assert.equal(exhausted[0]?.attempts, 1)
  })

  it('records correct delayMs in onRetryAttempt matching backoff policy', async () => {
    const { observer, attempts } = makeSpyObserver()
    let call = 0

    const client = new SorobanClient(
      {
        ...baseConfig,
        retry: {
          maxAttempts: 3,
          baseDelayMs: 100,
          backoffMultiplier: 2,
          maxDelayMs: 1_000,
          jitterStrategy: 'none',
        },
      },
      {
        fetchFn: async () => {
          call += 1
          if (call < 3) return new Response('unavailable', { status: 503 })
          return new Response(
            JSON.stringify({ jsonrpc: '2.0', id: 'ok', result: { events: [] } }),
            { status: 200 },
          )
        },
        sleepFn: async () => {},
        retryObserver: observer,
      },
    )

    await client.getContractEvents()

    assert.equal(attempts[0]?.delayMs, 100) // attempt 1: base
    assert.equal(attempts[1]?.delayMs, 200) // attempt 2: base * 2
  })
})

// ---------------------------------------------------------------------------
// noopRetryObserver
// ---------------------------------------------------------------------------

describe('noopRetryObserver', () => {
  it('has no methods defined (pure no-op)', () => {
    assert.equal(noopRetryObserver.onRetryAttempt, undefined)
    assert.equal(noopRetryObserver.onRetryExhausted, undefined)
    assert.equal(noopRetryObserver.onSuccess, undefined)
  })

  it('is safe to use as default without throwing', async () => {
    const client = new SorobanClient(baseConfig, {
      fetchFn: async () =>
        new Response(
          JSON.stringify({ jsonrpc: '2.0', id: '1', result: { events: [] } }),
          { status: 200 },
        ),
      // no retryObserver — defaults to noopRetryObserver
    })

    await assert.doesNotReject(client.getContractEvents())
  })
})

// ---------------------------------------------------------------------------
// createPrometheusRetryObserver
// ---------------------------------------------------------------------------

describe('createPrometheusRetryObserver', () => {
  beforeEach(() => {
    _resetPrometheusObserverCache()
  })

  it('returns noopRetryObserver when prom-client is unavailable', () => {
    // In the test environment prom-client may or may not be installed.
    // Either way the function must return a valid RetryObserver without throwing.
    const obs = createPrometheusRetryObserver()
    assert.ok(obs !== null && typeof obs === 'object')
  })

  it('returns the same singleton on repeated calls', () => {
    const a = createPrometheusRetryObserver()
    const b = createPrometheusRetryObserver()
    assert.strictEqual(a, b)
  })
})

// ---------------------------------------------------------------------------
// deliverWebhook observer integration
// ---------------------------------------------------------------------------

import { deliverWebhook } from '../services/webhooks/delivery.js'
import type { WebhookConfig, WebhookPayload } from '../services/webhooks/types.js'

const webhookConfig: WebhookConfig = {
  id: 'wh-1',
  url: 'https://example.com/hook',
  secret: 'supersecretkey1234567890',
  secretUpdatedAt: new Date(),
  events: ['bond.created'],
  active: true,
}

const webhookPayload: WebhookPayload = {
  event: 'bond.created',
  data: { address: 'GABC', bondedAmount: '100', bondStart: null, bondDuration: null, active: true },
  timestamp: new Date().toISOString(),
}

describe('deliverWebhook retry observer', () => {
  it('fires onSuccess on first successful delivery', async () => {
    const { observer, successes } = makeSpyObserver()

    await deliverWebhook(webhookConfig, webhookPayload, {
      fetchFn: async () => new Response('ok', { status: 200 }),
      retryObserver: observer,
    })

    assert.equal(successes.length, 1)
    assert.equal(successes[0]?.provider, 'webhook')
    assert.equal(successes[0]?.attempt, 1)
  })

  it('fires onRetryAttempt for each 5xx before success', async () => {
    const { observer, attempts, successes } = makeSpyObserver()
    let call = 0

    await deliverWebhook(webhookConfig, webhookPayload, {
      fetchFn: async () => {
        call += 1
        if (call < 3) return new Response('error', { status: 503 })
        return new Response('ok', { status: 200 })
      },
      sleepFn: async () => {},
      retryObserver: observer,
    })

    assert.equal(attempts.length, 2)
    assert.equal(attempts[0]?.provider, 'webhook')
    assert.equal(attempts[0]?.errorCode, 'HTTP_503')
    assert.equal(successes.length, 1)
    assert.equal(successes[0]?.attempt, 3)
  })

  it('fires onRetryExhausted immediately for 4xx (no retry)', async () => {
    const { observer, attempts, exhausted } = makeSpyObserver()

    await deliverWebhook(webhookConfig, webhookPayload, {
      fetchFn: async () => new Response('forbidden', { status: 403 }),
      retryObserver: observer,
    })

    assert.equal(attempts.length, 0)
    assert.equal(exhausted.length, 1)
    assert.equal(exhausted[0]?.errorCode, 'HTTP_403')
    assert.equal(exhausted[0]?.attempts, 1)
  })

  it('fires onRetryExhausted when all 5xx attempts fail', async () => {
    const { observer, exhausted } = makeSpyObserver()

    await deliverWebhook(webhookConfig, webhookPayload, {
      retryPolicy: { maxAttempts: 2 },
      fetchFn: async () => new Response('error', { status: 503 }),
      sleepFn: async () => {},
      retryObserver: observer,
    })

    assert.equal(exhausted.length, 1)
    assert.equal(exhausted[0]?.provider, 'webhook')
    assert.equal(exhausted[0]?.attempts, 2)
  })
})
