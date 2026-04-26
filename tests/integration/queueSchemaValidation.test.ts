/**
 * Integration tests: queue schema validation + poison-message DLQ routing.
 *
 * These tests exercise the full validation-to-DLQ pipeline end-to-end using
 * an in-memory DLQ sink.  No real database or external service is required,
 * making the suite runnable in any CI environment.
 *
 * Run with:
 *   node --import tsx/esm --test tests/integration/queueSchemaValidation.test.ts
 */
import assert from 'node:assert/strict'
import { describe, it, beforeEach } from 'node:test'

import {
  attestationEventSchema,
  withdrawalEventSchema,
  bondCreationEventSchema,
} from '../../src/schemas/queue.js'
import {
  DlqReasonCode,
  DlqRouter,
  validateAndRoute,
  type DlqSink,
} from '../../src/listeners/messageValidator.js'

// ── In-memory DLQ sink ────────────────────────────────────────────────────────

interface CapturedEntry {
  type: string
  data: unknown
  reason: string
}

class InMemoryDlqSink implements DlqSink {
  readonly messages: CapturedEntry[] = []

  async captureFailure(type: string, data: unknown, reason: string): Promise<void> {
    this.messages.push({ type, data, reason })
  }

  clear(): void {
    this.messages.length = 0
  }
}

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeValidAttestation() {
  return {
    id: 'op-int-1',
    pagingToken: 'cursor-int-1',
    type: 'add',
    subject: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV',
    verifier: 'GVERIFIERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    weight: 75,
    claim: 'KYC verified',
    createdAt: '2024-06-01T12:00:00.000Z',
    transactionHash: 'abcdef1234567890',
  }
}

function makeValidWithdrawal() {
  return {
    id: 'op-int-2',
    pagingToken: 'cursor-int-2',
    type: 'payment',
    createdAt: new Date('2024-06-01T12:00:00.000Z'),
    bondId: 'bond-int-1',
    account: 'GABC123',
    amount: '250.0000000',
    assetType: 'native',
    transactionHash: 'deadbeef12345678',
    operationIndex: 0,
  }
}

function makeValidBondCreation() {
  return {
    id: 'op-int-3',
    type: 'create_bond' as const,
    sourceAccount: 'GSOURCE123',
    amount: '1000.0000000',
    duration: '180',
  }
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('Queue schema validation + DLQ routing (integration)', () => {
  let sink: InMemoryDlqSink
  let router: DlqRouter

  beforeEach(() => {
    sink = new InMemoryDlqSink()
    router = new DlqRouter(sink)
  })

  // ── Attestation events ────────────────────────────────────────────────────

  describe('attestation events', () => {
    it('passes a valid add event without routing to DLQ', async () => {
      const result = await validateAndRoute(
        attestationEventSchema,
        'attestation',
        makeValidAttestation(),
        router,
      )

      assert.equal(result.valid, true)
      assert.equal(sink.messages.length, 0)
    })

    it('routes a malformed event to the DLQ with SCHEMA_VALIDATION_FAILED', async () => {
      const badEvent = { id: '', type: 'unknown_type', weight: 999 }

      const result = await validateAndRoute(attestationEventSchema, 'attestation', badEvent, router)

      assert.equal(result.valid, false)
      assert.equal(sink.messages.length, 1)

      const entry = sink.messages[0]
      assert.equal(entry.type, 'attestation')
      assert.ok(entry.reason.startsWith(`[${DlqReasonCode.SCHEMA_VALIDATION_FAILED}]`))
    })

    it('preserves the original payload in the DLQ entry', async () => {
      const badEvent = { totally: 'wrong' }

      await validateAndRoute(attestationEventSchema, 'attestation', badEvent, router)

      assert.deepEqual(sink.messages[0].data, badEvent)
    })

    it('routes a null payload to the DLQ', async () => {
      const result = await validateAndRoute(attestationEventSchema, 'attestation', null, router)

      assert.equal(result.valid, false)
      assert.equal(sink.messages.length, 1)
    })

    it('DLQ reason detail mentions the invalid field', async () => {
      const missingSubject = { ...makeValidAttestation(), subject: '' }

      const result = await validateAndRoute(attestationEventSchema, 'attestation', missingSubject, router)

      assert.equal(result.valid, false)
      assert.ok(sink.messages[0].reason.includes('subject'))
    })
  })

  // ── Withdrawal events ─────────────────────────────────────────────────────

  describe('withdrawal events', () => {
    it('passes a valid withdrawal event without routing to DLQ', async () => {
      const result = await validateAndRoute(
        withdrawalEventSchema,
        'withdrawal',
        makeValidWithdrawal(),
        router,
      )

      assert.equal(result.valid, true)
      assert.equal(sink.messages.length, 0)
    })

    it('routes an event with a negative amount to the DLQ', async () => {
      const badAmount = { ...makeValidWithdrawal(), amount: '-50.0' }

      const result = await validateAndRoute(withdrawalEventSchema, 'withdrawal', badAmount, router)

      assert.equal(result.valid, false)
      assert.equal(sink.messages.length, 1)
      assert.ok(sink.messages[0].reason.includes(DlqReasonCode.SCHEMA_VALIDATION_FAILED))
    })

    it('routes an event with a missing bondId to the DLQ', async () => {
      const { bondId: _id, ...noBondId } = makeValidWithdrawal()

      const result = await validateAndRoute(withdrawalEventSchema, 'withdrawal', noBondId, router)

      assert.equal(result.valid, false)
      assert.ok(sink.messages[0].reason.includes('bondId'))
    })

    it('accepts an ISO-8601 string for createdAt', async () => {
      const withStringDate = {
        ...makeValidWithdrawal(),
        createdAt: '2024-06-01T12:00:00.000Z',
      }

      const result = await validateAndRoute(withdrawalEventSchema, 'withdrawal', withStringDate, router)

      assert.equal(result.valid, true)
    })
  })

  // ── Bond creation events ──────────────────────────────────────────────────

  describe('bond creation events', () => {
    it('passes a valid bond creation event without routing to DLQ', async () => {
      const result = await validateAndRoute(
        bondCreationEventSchema,
        'bond_creation',
        makeValidBondCreation(),
        router,
      )

      assert.equal(result.valid, true)
      assert.equal(sink.messages.length, 0)
    })

    it('routes an event with the wrong type discriminant to the DLQ', async () => {
      const wrongType = { ...makeValidBondCreation(), type: 'payment' }

      const result = await validateAndRoute(bondCreationEventSchema, 'bond_creation', wrongType, router)

      assert.equal(result.valid, false)
      assert.equal(sink.messages.length, 1)
    })

    it('routes an event with a non-numeric amount to the DLQ', async () => {
      const badAmount = { ...makeValidBondCreation(), amount: 'N/A' }

      const result = await validateAndRoute(bondCreationEventSchema, 'bond_creation', badAmount, router)

      assert.equal(result.valid, false)
      assert.ok(sink.messages[0].reason.includes(DlqReasonCode.SCHEMA_VALIDATION_FAILED))
    })

    it('accepts null duration in a bond creation event', async () => {
      const withNullDuration = { ...makeValidBondCreation(), duration: null }

      const result = await validateAndRoute(
        bondCreationEventSchema,
        'bond_creation',
        withNullDuration,
        router,
      )

      assert.equal(result.valid, true)
    })
  })

  // ── Multi-message batch behaviour ─────────────────────────────────────────

  describe('batch processing', () => {
    it('routes only the invalid messages when a batch contains mixed validity', async () => {
      const events = [
        makeValidAttestation(),
        { id: '', type: 'bad' },           // invalid
        { ...makeValidAttestation(), id: 'op-int-ok-2', weight: 90 },
        { pagingToken: 'cursor-x' },       // invalid
      ]

      let validCount = 0
      for (const event of events) {
        const result = await validateAndRoute(attestationEventSchema, 'attestation', event, router)
        if (result.valid) validCount++
      }

      assert.equal(validCount, 2)
      assert.equal(sink.messages.length, 2)
      for (const msg of sink.messages) {
        assert.ok(msg.reason.startsWith(`[${DlqReasonCode.SCHEMA_VALIDATION_FAILED}]`))
      }
    })

    it('captures each poison message exactly once', async () => {
      const bad = { id: 'dup', type: 'bad' }

      await validateAndRoute(attestationEventSchema, 'attestation', bad, router)
      await validateAndRoute(attestationEventSchema, 'attestation', bad, router)

      // Two separate calls → two DLQ entries (dedup is the caller's responsibility)
      assert.equal(sink.messages.length, 2)
    })
  })
})
