/**
 * Integration tests for nested-service transaction rollback.
 *
 * Verifies that when multiple repository (or service) operations run inside a
 * single `TransactionManager.withTransaction()` call, any failure — whether an
 * explicit throw or a DB constraint violation — rolls back every write made
 * earlier in the same callback. No partial state should survive.
 *
 * Run against a real PostgreSQL instance:
 *   TEST_DATABASE_URL=postgres://... node --test tests/integration/nestedServiceRollback.test.ts
 * or let the suite spin up a Testcontainer automatically:
 *   node --test tests/integration/nestedServiceRollback.test.ts
 */

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import {
  AttestationsRepository,
  BondsRepository,
  IdentitiesRepository,
  ScoreHistoryRepository,
} from '../../src/db/repositories/index.js'
import { createSchema, dropSchema, resetDatabase } from '../../src/db/schema.js'
import {
  LockTimeoutError,
  LockTimeoutPolicy,
  TransactionManager,
} from '../../src/db/transaction.js'
import { createTestDatabase, type TestDatabase } from './testDatabase.js'

describe('nested service rollback', () => {
  let database: TestDatabase
  let txManager: TransactionManager

  // Pool-backed repositories used to inspect state *after* a transaction.
  let identitiesRepo: IdentitiesRepository
  let bondsRepo: BondsRepository
  let attestationsRepo: AttestationsRepository
  let scoreHistoryRepo: ScoreHistoryRepository

  before(async () => {
    database = await createTestDatabase()
    await createSchema(database.pool)

    txManager = new TransactionManager(database.pool, {
      readonly: 1_000,
      default: 3_000,
      critical: 8_000,
    })

    identitiesRepo = new IdentitiesRepository(database.pool)
    bondsRepo = new BondsRepository(database.pool)
    attestationsRepo = new AttestationsRepository(database.pool)
    scoreHistoryRepo = new ScoreHistoryRepository(database.pool)
  })

  beforeEach(async () => {
    await resetDatabase(database.pool)
  })

  after(async () => {
    await dropSchema(database.pool)
    await database.close()
  })

  // ---------------------------------------------------------------------------
  // Core rollback guarantee
  // ---------------------------------------------------------------------------

  it('rolls back all writes when a later step throws an application error', async () => {
    // Simulate a three-step service: create identity → create bond → score entry,
    // then deliberately throw before returning.
    await assert.rejects(
      () =>
        txManager.withTransaction(async (client) => {
          const idRepo = new IdentitiesRepository(client)
          const bRepo = new BondsRepository(client)
          const sRepo = new ScoreHistoryRepository(client)

          await idRepo.create({ address: 'GROLLBACK_ADDR_1' })

          await bRepo.create({
            identityAddress: 'GROLLBACK_ADDR_1',
            amount: '100',
            startTime: new Date('2025-01-01T00:00:00.000Z'),
            durationDays: 30,
          })

          await sRepo.create({
            identityAddress: 'GROLLBACK_ADDR_1',
            score: 75,
            source: 'bond',
          })

          // Simulate a failure in a downstream service call.
          throw new Error('downstream service failure')
        }),
      /downstream service failure/
    )

    // Nothing should have been persisted.
    assert.equal(
      await identitiesRepo.findByAddress('GROLLBACK_ADDR_1'),
      null,
      'identity must not be persisted after rollback'
    )
    assert.deepEqual(
      await bondsRepo.listByIdentity('GROLLBACK_ADDR_1'),
      [],
      'bonds must not be persisted after rollback'
    )
    assert.deepEqual(
      await scoreHistoryRepo.listByIdentity('GROLLBACK_ADDR_1'),
      [],
      'score history must not be persisted after rollback'
    )
  })

  it('rolls back partial writes caused by a DB constraint violation', async () => {
    // Pre-insert an identity so the duplicate-address constraint fires mid-transaction.
    await identitiesRepo.create({ address: 'GROLLBACK_DUPLICATE' })

    await assert.rejects(
      () =>
        txManager.withTransaction(async (client) => {
          const idRepo = new IdentitiesRepository(client)
          const sRepo = new ScoreHistoryRepository(client)

          // This first write succeeds inside the transaction…
          await idRepo.create({ address: 'GROLLBACK_SIBLING' })

          // …but this violates the unique constraint and aborts the transaction.
          await idRepo.create({ address: 'GROLLBACK_DUPLICATE' })

          // This line should never execute.
          await sRepo.create({
            identityAddress: 'GROLLBACK_SIBLING',
            score: 50,
            source: 'manual',
          })
        }),
      // PostgreSQL unique violation
      (err: unknown) => (err as { code?: string }).code === '23505'
    )

    // The sibling identity written before the violation must not survive.
    assert.equal(
      await identitiesRepo.findByAddress('GROLLBACK_SIBLING'),
      null,
      'sibling identity written before constraint violation must be rolled back'
    )

    // The pre-existing identity must still be intact.
    assert.notEqual(
      await identitiesRepo.findByAddress('GROLLBACK_DUPLICATE'),
      null,
      'pre-existing identity must remain untouched'
    )
  })

  it('commits successfully when all steps complete without error', async () => {
    const committed = await txManager.withTransaction(async (client) => {
      const idRepo = new IdentitiesRepository(client)
      const bRepo = new BondsRepository(client)

      const identity = await idRepo.create({
        address: 'GROLLBACK_COMMIT',
        displayName: 'Committed Alice',
      })

      const bond = await bRepo.create({
        identityAddress: identity.address,
        amount: '25',
        startTime: new Date('2025-03-01T00:00:00.000Z'),
        durationDays: 14,
      })

      return { identity, bond }
    })

    const persisted = await identitiesRepo.findByAddress('GROLLBACK_COMMIT')
    assert.ok(persisted, 'identity must be visible after successful commit')
    assert.equal(persisted.displayName, 'Committed Alice')

    const bonds = await bondsRepo.listByIdentity('GROLLBACK_COMMIT')
    assert.equal(bonds.length, 1)
    assert.equal(bonds[0].id, committed.bond.id)
  })

  it('rolls back across three service layers (identity → bond → attestation)', async () => {
    // Set up a pre-existing attester that lives outside the failing transaction.
    await identitiesRepo.create({ address: 'GROLLBACK_ATTESTER' })

    await assert.rejects(
      () =>
        txManager.withTransaction(async (client) => {
          const idRepo = new IdentitiesRepository(client)
          const bRepo = new BondsRepository(client)
          const aRepo = new AttestationsRepository(client)

          const identity = await idRepo.create({ address: 'GROLLBACK_SUBJECT' })

          const bond = await bRepo.create({
            identityAddress: identity.address,
            amount: '10',
            startTime: new Date('2025-06-01T00:00:00.000Z'),
            durationDays: 7,
          })

          await aRepo.create({
            bondId: bond.id,
            attesterAddress: 'GROLLBACK_ATTESTER',
            subjectAddress: identity.address,
            score: 88,
          })

          throw new Error('third-layer failure')
        }),
      /third-layer failure/
    )

    assert.equal(
      await identitiesRepo.findByAddress('GROLLBACK_SUBJECT'),
      null,
      'subject identity must be rolled back'
    )
    assert.deepEqual(
      await bondsRepo.listByIdentity('GROLLBACK_SUBJECT'),
      [],
      'bond must be rolled back'
    )

    // The attester (created outside the transaction) must be unaffected.
    assert.notEqual(
      await identitiesRepo.findByAddress('GROLLBACK_ATTESTER'),
      null,
      'attester created outside the failing transaction must survive'
    )
  })

  it('preserves isolation — in-flight writes are invisible to concurrent readers', async () => {
    // Writes inside an uncommitted transaction must not be visible outside it.
    let transactionRunning = false

    const txPromise = txManager.withTransaction(async (client) => {
      const idRepo = new IdentitiesRepository(client)
      await idRepo.create({ address: 'GROLLBACK_INFLIGHT' })
      transactionRunning = true

      // Yield so the check below can run while the transaction is still open.
      await sleep(50)

      throw new Error('abort to test isolation')
    })

    // Poll briefly until the transaction has written but not yet committed.
    while (!transactionRunning) {
      await sleep(5)
    }

    // A pool query (outside the transaction) must not see the uncommitted row.
    const snapshot = await identitiesRepo.findByAddress('GROLLBACK_INFLIGHT')
    assert.equal(
      snapshot,
      null,
      'uncommitted writes must not be visible to concurrent readers'
    )

    // Wait for the transaction to abort and confirm nothing was committed.
    await assert.rejects(txPromise, /abort to test isolation/)

    assert.equal(
      await identitiesRepo.findByAddress('GROLLBACK_INFLIGHT'),
      null,
      'rolled-back write must not appear after transaction aborts'
    )
  })

  // ---------------------------------------------------------------------------
  // LockTimeoutError propagation
  // ---------------------------------------------------------------------------

  it('propagates LockTimeoutError when lock cannot be acquired', async () => {
    // Create test data outside the transaction.
    await identitiesRepo.create({ address: 'GROLLBACK_LOCK_OWNER' })
    const bond = await bondsRepo.create({
      identityAddress: 'GROLLBACK_LOCK_OWNER',
      amount: '5',
      startTime: new Date('2025-01-01T00:00:00.000Z'),
      durationDays: 10,
    })

    // Hold a row lock in a separate client so the next transaction times out.
    const holder = await database.pool.connect()
    await holder.query('BEGIN')
    await holder.query('SELECT id FROM bonds WHERE id = $1 FOR UPDATE', [bond.id])

    try {
      await assert.rejects(
        () =>
          txManager.withTransaction(
            async (client) => {
              await client.query('SELECT id FROM bonds WHERE id = $1 FOR UPDATE', [bond.id])
            },
            { policy: LockTimeoutPolicy.READONLY, timeoutMs: 100 }
          ),
        (err: unknown) => err instanceof LockTimeoutError
      )
    } finally {
      await holder.query('ROLLBACK')
      holder.release()
    }

    // Bond state must be intact — the failed transaction changed nothing.
    const intact = await bondsRepo.findById(bond.id)
    assert.ok(intact)
    assert.equal(intact.amount, bond.amount)
  })
})

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
