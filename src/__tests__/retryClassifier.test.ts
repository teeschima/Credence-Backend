/**
 * Retry classifier tests for overlapping transient error scenarios.
 *
 * Covers the edge cases where timeout and connection-reset signals arrive
 * simultaneously, ensuring the classifier always picks the correct code and
 * that SorobanClient retries (or surfaces) the right error type.
 */
import { describe, it, expect } from 'vitest'
import { SorobanClient, SorobanClientError } from '../clients/soroban.js'
import { TimeoutExceededError } from '../lib/timeoutExecutor.js'
import { normalizeTransportError } from '../clients/httpErrors.js'
import { classifyTransportError } from '../utils/retryClassifier.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseConfig = {
  rpcUrl: 'http://localhost:8000',
  network: 'testnet' as const,
  contractId: 'CONTRACT_ID',
}

function makeAbortError(): Error {
  const e = new Error('Aborted')
  e.name = 'AbortError'
  return e
}

function makeNodeError(code: string): Error {
  const e = new Error(`connect ${code}`)
  ;(e as any).code = code
  return e
}

function makeWrappedAbortError(): TypeError {
  const cause = makeAbortError()
  const wrapper = new TypeError('fetch failed')
  ;(wrapper as any).cause = cause
  return wrapper
}

/** Simulates undici emitting TypeError("fetch failed") when both abort and reset fire. */
function makeWrappedResetError(): TypeError {
  const cause = makeNodeError('ECONNRESET')
  const wrapper = new TypeError('fetch failed')
  ;(wrapper as any).cause = cause
  return wrapper
}

// ---------------------------------------------------------------------------
// normalizeTransportError overlap scenarios
// ---------------------------------------------------------------------------

describe('normalizeTransportError – timeout+reset overlap', () => {
  it('AbortError wins over RESET when abort fires first → TIMEOUT', () => {
    expect(normalizeTransportError(makeAbortError())?.code).toBe('TIMEOUT')
  })

  it('undici TypeError wrapping AbortError → TIMEOUT', () => {
    // undici may emit TypeError("fetch failed") { cause: AbortError } when
    // both the abort signal and a reset arrive simultaneously.
    expect(normalizeTransportError(makeWrappedAbortError())?.code).toBe('TIMEOUT')
  })

  it('ECONNRESET with no abort signal → RESET', () => {
    expect(normalizeTransportError(makeNodeError('ECONNRESET'))?.code).toBe('RESET')
  })

  it('undici TypeError wrapping ECONNRESET → RESET', () => {
    expect(normalizeTransportError(makeWrappedResetError())?.code).toBe('RESET')
  })

  it('ETIMEDOUT (OS-level) → TIMEOUT', () => {
    expect(normalizeTransportError(makeNodeError('ETIMEDOUT'))?.code).toBe('TIMEOUT')
  })

  it('EPIPE → RESET', () => {
    expect(normalizeTransportError(makeNodeError('EPIPE'))?.code).toBe('RESET')
  })

  it('ECONNREFUSED → REFUSED', () => {
    expect(normalizeTransportError(makeNodeError('ECONNREFUSED'))?.code).toBe('REFUSED')
  })

  it('non-transport SyntaxError → null (not retriable as transport)', () => {
    expect(normalizeTransportError(new SyntaxError('bad json'))).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// classifyTransportError – unified retry decision
// ---------------------------------------------------------------------------

describe('classifyTransportError – retry decision', () => {
  it('AbortError → retryable TIMEOUT', () => {
    const d = classifyTransportError(makeAbortError())
    expect(d.retryable).toBe(true)
    if (d.retryable) expect(d.code).toBe('TIMEOUT')
  })

  it('TypeError wrapping AbortError → retryable TIMEOUT (overlap wins)', () => {
    const d = classifyTransportError(makeWrappedAbortError())
    expect(d.retryable).toBe(true)
    if (d.retryable) expect(d.code).toBe('TIMEOUT')
  })

  it('ECONNRESET → retryable RESET', () => {
    const d = classifyTransportError(makeNodeError('ECONNRESET'))
    expect(d.retryable).toBe(true)
    if (d.retryable) expect(d.code).toBe('RESET')
  })

  it('ECONNREFUSED → retryable REFUSED', () => {
    const d = classifyTransportError(makeNodeError('ECONNREFUSED'))
    expect(d.retryable).toBe(true)
    if (d.retryable) expect(d.code).toBe('REFUSED')
  })

  it('SyntaxError → not retryable', () => {
    const d = classifyTransportError(new SyntaxError('bad json'))
    expect(d.retryable).toBe(false)
  })

  it('plain string → not retryable', () => {
    const d = classifyTransportError('something went wrong')
    expect(d.retryable).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// SorobanClient.normalizeError – TimeoutExceededError classification
// ---------------------------------------------------------------------------

describe('SorobanClient retry classifier – TimeoutExceededError', () => {
  it('classifies TimeoutExceededError as TIMEOUT_ERROR (not NETWORK_ERROR)', async () => {
    const client = new SorobanClient(
      { ...baseConfig, timeoutMs: 50, retry: { maxAttempts: 1, baseDelayMs: 1, backoffMultiplier: 1, maxDelayMs: 1 } },
      {
        fetchFn: async (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(makeAbortError()))
          }),
        sleepFn: async () => {},
      },
    )

    await expect(client.getContractEvents()).rejects.toSatisfy((err: unknown) => {
      return err instanceof SorobanClientError && err.code === 'TIMEOUT_ERROR'
    })
  })

  it('retries on TIMEOUT_ERROR and surfaces it after max attempts', async () => {
    let calls = 0
    const client = new SorobanClient(
      { ...baseConfig, timeoutMs: 50, retry: { maxAttempts: 2, baseDelayMs: 1, backoffMultiplier: 1, maxDelayMs: 1 } },
      {
        fetchFn: async (_url, init) =>
          new Promise((_resolve, reject) => {
            calls++
            init?.signal?.addEventListener('abort', () => reject(makeAbortError()))
          }),
        sleepFn: async () => {},
      },
    )

    await expect(client.getContractEvents()).rejects.toSatisfy((err: unknown) => {
      return err instanceof SorobanClientError && err.code === 'TIMEOUT_ERROR' && err.attempts === 2
    })
    expect(calls).toBe(2)
  })

  it('classifies TypeError wrapping AbortError as TIMEOUT_ERROR (overlap scenario)', async () => {
    // Simulates undici emitting TypeError("fetch failed") { cause: AbortError }
    // when both the abort signal and a connection reset arrive simultaneously.
    const client = new SorobanClient(
      { ...baseConfig, retry: { maxAttempts: 1, baseDelayMs: 1, backoffMultiplier: 1, maxDelayMs: 1 } },
      {
        fetchFn: async () => { throw makeWrappedAbortError() },
        sleepFn: async () => {},
      },
    )

    await expect(client.getContractEvents()).rejects.toSatisfy((err: unknown) => {
      return err instanceof SorobanClientError && err.code === 'TIMEOUT_ERROR'
    })
  })

  it('retries on NETWORK_ERROR (ECONNRESET) and surfaces it after max attempts', async () => {
    let calls = 0
    const client = new SorobanClient(
      { ...baseConfig, retry: { maxAttempts: 2, baseDelayMs: 1, backoffMultiplier: 1, maxDelayMs: 1 } },
      {
        fetchFn: async () => {
          calls++
          throw makeNodeError('ECONNRESET')
        },
        sleepFn: async () => {},
      },
    )

    await expect(client.getContractEvents()).rejects.toSatisfy((err: unknown) => {
      return err instanceof SorobanClientError && err.code === 'NETWORK_ERROR'
    })
    expect(calls).toBe(2)
  })

  it('does not retry PARSE_ERROR (non-transient)', async () => {
    let calls = 0
    const client = new SorobanClient(
      { ...baseConfig, retry: { maxAttempts: 3, baseDelayMs: 1, backoffMultiplier: 1, maxDelayMs: 1 } },
      {
        fetchFn: async () => {
          calls++
          return new Response('not-json', { status: 200 })
        },
        sleepFn: async () => {},
      },
    )

    await expect(client.getContractEvents()).rejects.toSatisfy((err: unknown) => {
      return err instanceof SorobanClientError && err.code === 'PARSE_ERROR'
    })
    expect(calls).toBe(1) // no retry
  })

  it('does not retry RPC_ERROR with non-retriable code', async () => {
    let calls = 0
    const client = new SorobanClient(
      { ...baseConfig, retry: { maxAttempts: 3, baseDelayMs: 1, backoffMultiplier: 1, maxDelayMs: 1 } },
      {
        fetchFn: async () => {
          calls++
          return new Response(
            JSON.stringify({ jsonrpc: '2.0', id: 'x', error: { code: -32600, message: 'Invalid request' } }),
            { status: 200 },
          )
        },
        sleepFn: async () => {},
      },
    )

    await expect(client.getContractEvents()).rejects.toSatisfy((err: unknown) => {
      return err instanceof SorobanClientError && err.code === 'RPC_ERROR'
    })
    expect(calls).toBe(1) // no retry
  })
})
