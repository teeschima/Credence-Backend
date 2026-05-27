import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createTestDatabase, createTestCache, type TestDatabase, type TestCache } from './testDatabase.js'
import { runMigration } from '../../src/migrations/runner.js'

// We need to define these variables here so they are available in the test scope
let db: TestDatabase
let cache: TestCache

// Mock the pool and cache globally for the app
vi.mock('../../src/db/pool.js', () => ({
  pool: {
    query: (text: string, params?: any[]) => db.pool.query(text, params),
    on: vi.fn(),
  }
}))

vi.mock('../../src/cache/index.js', () => ({
  cache: {
    get: (ns: string, k: string) => cache.client.get(`${ns}:${k}`).then(v => v ? JSON.parse(v) : null),
    set: (ns: string, k: string, v: any, ttl?: number) => cache.client.set(`${ns}:${k}`, JSON.stringify(v)),
    delete: (ns: string, k: string) => cache.client.del(`${ns}:${k}`),
    deleteNS: (ns: string) => cache.client.flushAll(), // Close enough for test
  }
}))

// Mock Horizon Stream
const streamState = {
  onmessage: undefined as undefined | ((op: any) => Promise<void>),
}

vi.mock('@stellar/stellar-sdk', () => {
  class ServerMock {
    operations() {
      return {
        forAsset: () => ({
          cursor: () => ({
            stream: ({ onmessage }: { onmessage: (op: any) => Promise<void> }) => {
              streamState.onmessage = onmessage
            },
          }),
        }),
      }
    }
  }

  return { Horizon: { Server: ServerMock } }
})

// We import app AFTER the mocks
const { default: app } = await import('../../src/app.js')

describe('E2E State Sync Integration: Horizon -> DB -> Trust -> Cache -> API', () => {
  beforeAll(async () => {
    // 1. Start Postgres and Redis containers (or fallbacks)
    db = await createTestDatabase()
    cache = await createTestCache()

    // 2. Point current pool and cache to our test containers
    process.env.DB_URL = db.connectionString
    process.env.REDIS_URL = cache.connectionString
    // Mock API key for middleware
    process.env.API_KEY = 'test-api-key'

    // 3. Run migrations on the test database
    if (db.connectionString.startsWith('pg-mem://')) {
      await db.pool.query('CREATE TABLE identities (id SERIAL PRIMARY KEY, address VARCHAR(64) UNIQUE, bonded_amount VARCHAR(78) DEFAULT \'0\', bond_start TIMESTAMP, bond_duration INTEGER, active BOOLEAN DEFAULT FALSE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)')
      await db.pool.query('CREATE TABLE attestations (id SERIAL PRIMARY KEY, bond_id INTEGER, attester_address VARCHAR(64), subject_address VARCHAR(64), score INTEGER, note TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)')
    } else {
      const migrationResult = await runMigration({
        direction: 'up',
        config: {
          databaseUrl: db.connectionString,
          migrationsDir: 'src/migrations',
          migrationsTable: 'pgmigrations',
          migrationsSchema: 'public',
          createSchema: true,
          transactional: true,
        },
        skipPreflight: true,
      })

      if (!migrationResult.success) {
        throw new Error(`Migrations failed: ${migrationResult.error}`)
      }
    }
  }, 60000)

  afterAll(async () => {
    if (db) await db.close()
    if (cache) await cache.close()
  })

  it('completes the full cycle: Horizon bond -> Sync -> Score -> Cache -> API', async () => {
    const { subscribeBondCreationEvents } = await import('../../src/listeners/horizonBondEvents.js')
    
    const address = 'GD7XW6Q6V6O6V6O6V6O6V6O6V6O6V6O6V6O6V6O6V6O6V6O6V6O6V6O4'
    const bondId = 'bond_xyz'
    const amount = '1000000000000000000' // 1 ETH in wei
    const duration = '365'

    // 1. Trigger Horizon event
    subscribeBondCreationEvents()
    await streamState.onmessage!({
      id: bondId,
      transaction_hash: 'hash_123',
      created_at: new Date().toISOString(),
      type: 'create_bond',
      source_account: address,
      amount: amount,
      duration: duration,
      paging_token: '12345',
      asset_code: 'BOND',
      asset_issuer: 'G_ISSUER'
    })

    // 2. Wait for sync processing (small delay)
    await new Promise(resolve => setTimeout(resolve, 500))

    // 3. Verify score via API (incorporates bond and duration)
    const response = await request(app)
      .get(`/api/trust/${address}`)
      .set('x-api-key', 'test-api-key')
    
    expect(response.status).toBe(200)
    expect(response.body.address).toBe(address)
    expect(response.body.score).toBeGreaterThan(0)

    // 4. Verify Cache
    const cached = await cache.client.get(`trust:${address.toLowerCase()}`)
    expect(cached).not.toBeNull()
  })

  it('integrates attestation events into the full cycle', async () => {
    // Use the listener's internal function if exposed or simulate through the DB
    const { pool } = await import('../../src/db/pool.js')
    const { invalidateTrustScoreCache } = await import('../../src/services/reputationService.js')
    
    const subject = 'GD7XW6Q6V6O6V6O6V6O6V6O6V6O6V6O6V6O6V6O6V6O6V6O6V6O6V6O2'
    const verifier = 'GD7XW6Q6V6O6V6O6V6O6V6O6V6O6V6O6V6O6V6O6V6O6V6O6V6O6V6O3'

    // 1. Pre-seed identity
    await pool.query('INSERT INTO identities (address) VALUES ($1) ON CONFLICT DO NOTHING', [subject])

    // 2. Manually insert attestation (simulating what the listener does)
    await pool.query(
      'INSERT INTO attestations (bond_id, attester_address, subject_address, score, note) VALUES ($1, $2, $3, $4, $5)',
      [1, verifier, subject, 10, 'Strong trust']
    )
    
    // Invalidate cache manually as we are bypassing the listener for simplicity in this fallback environment
    await invalidateTrustScoreCache(subject)

    // 3. Verify score via API
    const response = await request(app)
      .get(`/api/trust/${subject}`)
      .set('x-api-key', 'test-api-key')
    
    expect(response.status).toBe(200)
    expect(response.body.score).toBe(6) // (1/5) * 30

    // 4. Verify Cache status
    const cached = await cache.client.get(`trust:${subject.toLowerCase()}`)
    expect(cached).not.toBeNull()
  })

  it('returns 404 for missing identity', async () => {
    const response = await request(app).get('/api/trust/GD7XW6Q6V6O6V6O6V6O6V6O6V6O6V6O6V6O6V6O6V6O6V6O6V6O6V6O6')
    expect(response.status).toBe(404)
  })
})
