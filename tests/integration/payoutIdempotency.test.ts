import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest'
import request from 'supertest'
import app from '../../src/app.js'
import { createTestDatabase, type TestDatabase } from './testDatabase.js'
import { createSchema, dropSchema, resetDatabase } from '../../src/db/schema.js'
import { IdentitiesRepository, BondsRepository } from '../../src/db/repositories/index.js'

describe('Payout Idempotency Integration', () => {
  let database: TestDatabase
  let identitiesRepo: IdentitiesRepository
  let bondsRepo: BondsRepository
  let bondId: any

  beforeAll(async () => {
    database = await createTestDatabase()
    await createSchema(database.pool)
    
    identitiesRepo = new IdentitiesRepository(database.pool)
    bondsRepo = new BondsRepository(database.pool)
  })

  beforeEach(async () => {
    await resetDatabase(database.pool)
    
    // Setup test data: identity and bond
    const identity = await identitiesRepo.create({
      address: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2',
      displayName: 'Test Identity'
    })
    
    const bond = await bondsRepo.create({
      identityAddress: identity.address,
      amount: '1000',
      startTime: new Date(),
      durationDays: 30,
      status: 'active'
    })
    bondId = bond.id
  })

  afterAll(async () => {
    await dropSchema(database.pool)
    await database.close()
  })

  it('should create a payout and then return the same response for the same idempotency key', async () => {
    const payoutData = {
      bondId,
      amount: '100',
      transactionHash: 'tx_123_abc',
      status: 'settled'
    }

    const idempotencyKey = 'test-key-123'

    // First request
    const res1 = await request(app)
      .post('/api/payouts')
      .set('Idempotency-Key', idempotencyKey)
      .send(payoutData)

    expect(res1.status).toBe(201)
    expect(res1.body.success).toBe(true)
    expect(res1.body.data.amount).toBe('100')
    const firstPayoutId = res1.body.data.id

    // Second request with same key
    const res2 = await request(app)
      .post('/api/payouts')
      .set('Idempotency-Key', idempotencyKey)
      .send(payoutData)

    expect(res2.status).toBe(201) // Replayed status
    expect(res2.body).toEqual(res1.body)
    expect(res2.body.data.id).toBe(firstPayoutId)
  })

  it('should return 400 if the same idempotency key is used with a different payload', async () => {
    const payoutData1 = {
      bondId,
      amount: '100',
      transactionHash: 'tx_123_abc'
    }

    const payoutData2 = {
      bondId,
      amount: '200', // Different amount
      transactionHash: 'tx_123_abc'
    }

    const idempotencyKey = 'test-key-456'

    // First request
    await request(app)
      .post('/api/payouts')
      .set('Idempotency-Key', idempotencyKey)
      .send(payoutData1)
      .expect(201)

    // Second request with different payload
    const res2 = await request(app)
      .post('/api/payouts')
      .set('Idempotency-Key', idempotencyKey)
      .send(payoutData2)

    expect(res2.status).toBe(400)
    expect(res2.body.error).toBe('IdempotencyParameterMismatch')
  })

  it('should ignore key order in payload for hash comparison', async () => {
    const payoutData1 = {
      bondId,
      amount: '100',
      transactionHash: 'tx_789'
    }

    const payoutData2 = {
      transactionHash: 'tx_789', // Different order
      amount: '100',
      bondId
    }

    const idempotencyKey = 'test-key-canonical'

    // First request
    const res1 = await request(app)
      .post('/api/payouts')
      .set('Idempotency-Key', idempotencyKey)
      .send(payoutData1)
      .expect(201)

    // Second request with different key order but semantically identical payload
    const res2 = await request(app)
      .post('/api/payouts')
      .set('Idempotency-Key', idempotencyKey)
      .send(payoutData2)

    expect(res2.status).toBe(201)
    expect(res2.body).toEqual(res1.body)
  })
})
