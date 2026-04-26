/**
 * Integration tests for IdempotentConsumer
 *
 * These tests verify at-least-once delivery guarantees with duplicate messages.
 * Run with:
 *   TEST_DATABASE_URL=postgres://... node --test tests/integration/idempotentConsumer.test.ts
 * or let the test harness spin up a Testcontainer automatically.
 */

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { IdempotencyRepository } from '../../src/db/repositories/index.js'
import { createSchema, dropSchema, resetDatabase } from '../../src/db/schema.js'
import { createTestDatabase, type TestDatabase } from './testDatabase.js'
import { IdempotentConsumer } from '../../src/services/idempotentConsumer.js'

describe('IdempotentConsumer – integration', () => {
  let database: TestDatabase
  let repo: IdempotencyRepository
  let consumer: IdempotentConsumer

  before(async () => {
    database = await createTestDatabase()
    await createSchema(database.pool)

    repo = new IdempotencyRepository(database.pool)
    consumer = new IdempotentConsumer(repo, { expiresInSeconds: 3600 })
  })

  beforeEach(async () => {
    await resetDatabase(database.pool)
  })

  after(async () => {
    await dropSchema(database.pool)
    await database.close()
  })

  it('processes new message and stores result', async () => {
    const messageId = 'msg-001'
    const handler = async () => ({ status: 'processed' })

    const result = await consumer.process(messageId, handler)

    assert.equal(result.success, true)
    assert.deepEqual(result.result, { status: 'processed' })
  })

  it('skips already-processed message', async () => {
    const messageId = 'msg-002'
    const handler = async () => ({ status: 'first' })

    await consumer.process(messageId, handler)
    const result = await consumer.process(messageId, async () => ({
      status: 'second',
    }))

    assert.equal(result.success, true)
    assert.deepEqual(result.result, { status: 'first' })
  })

  it('handles concurrent duplicate messages correctly', async () => {
    const messageId = 'msg-concurrent-001'
    let callCount = 0

    const handler = async () => {
      callCount++
      await new Promise((r) => setTimeout(r, 50))
      return { callCount }
    }

    const [result1, result2, result3] = await Promise.all([
      consumer.process(messageId, handler),
      consumer.process(messageId, handler),
      consumer.process(messageId, handler),
    ])

    assert.equal(callCount, 1, 'handler should only be called once')
    assert.equal(result1.success, true)
    assert.equal(result2.success, true)
    assert.equal(result3.success, true)
    assert.deepEqual(result1.result, result2.result)
  })

  it('stores error result on handler failure', async () => {
    const messageId = 'msg-error-001'
    const handler = async () => {
      throw new Error('Handler error')
    }

    const result = await consumer.process(messageId, handler)

    assert.equal(result.success, false)
    assert.equal(result.error, 'Handler error')
  })

  it('does not retry failed message', async () => {
    const messageId = 'msg-error-002'
    let callCount = 0
    const handler = async () => {
      callCount++
      throw new Error('Persistent error')
    }

    await consumer.process(messageId, handler)
    const cachedResult = await consumer.process(messageId, handler)

    assert.equal(callCount, 1, 'failed handler should not be retried')
    assert.equal(cachedResult.success, false)
  })

  it('isProcessed returns correct status', async () => {
    const messageId = 'msg-check-001'

    assert.equal(await consumer.isProcessed(messageId), false)

    await consumer.process(messageId, async () => ({ done: true }))

    assert.equal(await consumer.isProcessed(messageId), true)
  })

  it('getResult returns cached result', async () => {
    const messageId = 'msg-result-001'
    await consumer.process(messageId, async () => ({ value: 42 }))

    const result = await consumer.getResult(messageId)

    assert.notEqual(result, null)
    assert.deepEqual(result?.result, { value: 42 })
  })

  it('returns null for unprocessed message getResult', async () => {
    const messageId = 'msg-null-001'
    const result = await consumer.getResult(messageId)

    assert.equal(result, null)
  })
})