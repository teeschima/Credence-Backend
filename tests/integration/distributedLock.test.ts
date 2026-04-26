import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DistributedLock } from '../../src/jobs/distributedLock.js'
import { JobScheduler } from '../../src/jobs/scheduler.js'
import { 
  LockedInvoiceDueDateWorker,
  LockedExportWorker,
  LockedAnalyticsRefreshWorker,
  createLockedInvoiceDueDateWorker,
  createLockedExportWorker,
  createLockedAnalyticsRefreshWorker
} from '../../src/jobs/lockedWorkers.js'
import { InvoiceDueDateWorker } from '../../src/jobs/invoiceDueDateWorker.js'
import { ExportWorker } from '../../src/jobs/exportWorker.js'
import { AnalyticsRefreshWorker } from '../../src/jobs/analyticsRefreshWorker.js'
import type { ScoreSnapshotJob } from '../../src/jobs/scoreSnapshot.js'

// ---------------------------------------------------------------------------
// In-memory Redis stub – mimics SET NX PX, GET, DEL, PEXPIRE via Lua eval
// ---------------------------------------------------------------------------

interface StoreEntry {
  value: string
  expiresAt: number
}

function makeFakeRedis() {
  const store = new Map<string, StoreEntry>()

  function isAlive(entry: StoreEntry | undefined): entry is StoreEntry {
    return entry !== undefined && entry.expiresAt > Date.now()
  }

  return {
    _store: store,

    async set(
      key: string,
      value: string,
      options?: { NX?: boolean; PX?: number }
    ): Promise<string | null> {
      const existing = store.get(key)
      if (options?.NX && isAlive(existing)) {
        return null
      }
      store.set(key, {
        value,
        expiresAt: options?.PX ? Date.now() + options.PX : Infinity,
      })
      return 'OK'
    },

    /** Dispatches the correct script logic based on argument count. */
    async eval(
      _script: string,
      opts: { keys: string[]; arguments: string[] }
    ): Promise<number> {
      const key = opts.keys[0]
      const token = opts.arguments[0]
      const entry = store.get(key)

      if (!isAlive(entry) || entry.value !== token) {
        return 0
      }

      if (opts.arguments.length === 1) {
        // RELEASE: del key
        store.delete(key)
        return 1
      } else {
        // HEARTBEAT: pexpire key ttlMs
        entry.expiresAt = Date.now() + parseInt(opts.arguments[1])
        return 1
      }
    },
  }
}

type FakeRedis = ReturnType<typeof makeFakeRedis>

// ---------------------------------------------------------------------------
// Mock implementations for workers
// ---------------------------------------------------------------------------

function makeMockInvoiceDueDateWorker() {
  const mockRepository = {
    listPendingDueDateInvoices: vi.fn().mockResolvedValue([]),
    markDueDateActionTriggered: vi.fn().mockResolvedValue(undefined),
  }
  
  const mockTenantProvider = {
    listTenants: vi.fn().mockResolvedValue([
      { tenantId: 'tenant1', timezone: 'UTC' },
      { tenantId: 'tenant2', timezone: 'America/New_York' },
    ]),
  }

  return new InvoiceDueDateWorker(mockRepository, mockTenantProvider, {
    logger: vi.fn(),
  })
}

function makeMockExportWorker() {
  const mockDataSource = {
    getTotalCount: vi.fn().mockResolvedValue(1000),
    openCursor: vi.fn().mockImplementation(function* (batchSize) {
      // Generate mock data in batches
      for (let i = 0; i < 10; i++) {
        const batch = Array.from({ length: batchSize }, (_, j) => ({
          id: i * batchSize + j,
          data: `row_${i * batchSize + j}`,
        }))
        yield batch
      }
    }),
  }

  const mockWriter = {
    open: vi.fn().mockResolvedValue(undefined),
    writeBatch: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
  }

  return new ExportWorker(mockDataSource, mockWriter, {
    logger: vi.fn(),
  })
}

function makeMockAnalyticsRefreshWorker() {
  const mockAnalyticsService = {
    refreshConcurrently: vi.fn().mockResolvedValue(undefined),
  }

  return new AnalyticsRefreshWorker(mockAnalyticsService, vi.fn())
}

// ---------------------------------------------------------------------------
// Integration Tests
// ---------------------------------------------------------------------------

describe('DistributedLock Integration Tests', () => {
  let sharedRedis: FakeRedis
  let lockA: DistributedLock
  let lockB: DistributedLock

  beforeEach(() => {
    sharedRedis = makeFakeRedis()
    lockA = new DistributedLock(sharedRedis as any, 30_000)
    lockB = new DistributedLock(sharedRedis as any, 30_000)
  })

  afterEach(() => {
    lockA.resetMetrics()
    lockB.resetMetrics()
  })

  describe('Basic Lock Functionality', () => {
    it('prevents concurrent execution of the same job key', async () => {
      let executionCount = 0
      const jobKey = 'test:concurrent-job'

      // Worker A acquires lock and runs
      const resultA = await lockA.withLock(jobKey, async () => {
        executionCount++
        await new Promise(resolve => setTimeout(resolve, 50))
        return 'worker-a-result'
      })

      // Worker B attempts to run same job simultaneously
      const resultB = await lockB.withLock(jobKey, async () => {
        executionCount++
        return 'worker-b-result'
      })

      expect(resultA.executed).toBe(true)
      expect(resultA.result).toBe('worker-a-result')
      expect(resultB.executed).toBe(false)
      expect(resultB.result).toBeUndefined()
      expect(executionCount).toBe(1)
    })

    it('allows sequential execution after lock release', async () => {
      let executionOrder: string[] = []
      const jobKey = 'test:sequential-job'

      // First execution
      const result1 = await lockA.withLock(jobKey, async () => {
        executionOrder.push('first')
        return 'first-result'
      })

      // Second execution after first completes
      const result2 = await lockB.withLock(jobKey, async () => {
        executionOrder.push('second')
        return 'second-result'
      })

      expect(result1.executed).toBe(true)
      expect(result2.executed).toBe(true)
      expect(executionOrder).toEqual(['first', 'second'])
    })

    it('handles lock expiry gracefully', async () => {
      const jobKey = 'test:expiry-job'
      const shortTtl = 100 // 100ms TTL

      // Acquire lock with short TTL
      const token = await lockA.acquire(jobKey, shortTtl)
      expect(token).not.toBeNull()

      // Wait for lock to expire
      await new Promise(resolve => setTimeout(resolve, 150))

      // Now worker B should be able to acquire
      const resultB = await lockB.withLock(jobKey, async () => {
        return 'worker-b-result'
      })

      expect(resultB.executed).toBe(true)
      expect(resultB.result).toBe('worker-b-result')
    })
  })

  describe('LockedInvoiceDueDateWorker', () => {
    it('prevents duplicate execution across workers', async () => {
      const baseWorker = makeMockInvoiceDueDateWorker()
      const lockKey = 'cron:invoice-due-date'
      
      const lockedWorkerA = createLockedInvoiceDueDateWorker(
        baseWorker, lockA, lockKey, { logger: vi.fn() }
      )
      const lockedWorkerB = createLockedInvoiceDueDateWorker(
        baseWorker, lockB, lockKey, { logger: vi.fn() }
      )

      // Run both workers simultaneously
      const [resultA, resultB] = await Promise.all([
        lockedWorkerA.run(),
        lockedWorkerB.run(),
      ])

      // Only one should execute
      expect(resultA).not.toBeNull()
      expect(resultB).toBeNull()
      
      const totalExecutions = (resultA ? 1 : 0) + (resultB ? 1 : 0)
      expect(totalExecutions).toBe(1)
    })

    it('returns null when lock is not acquired', async () => {
      const baseWorker = makeMockInvoiceDueDateWorker()
      const lockKey = 'cron:invoice-due-date'
      
      // Pre-acquire lock with worker A
      await lockA.acquire(lockKey, 10_000)
      
      const lockedWorkerB = createLockedInvoiceDueDateWorker(
        baseWorker, lockB, lockKey, { logger: vi.fn() }
      )

      const result = await lockedWorkerB.run()
      expect(result).toBeNull()
    })
  })

  describe('LockedExportWorker', () => {
    it('prevents duplicate export execution', async () => {
      const baseWorker = makeMockExportWorker()
      const lockKey = 'cron:data-export'
      
      const lockedWorkerA = createLockedExportWorker(
        baseWorker, lockA, lockKey, { logger: vi.fn() }
      )
      const lockedWorkerB = createLockedExportWorker(
        baseWorker, lockB, lockKey, { logger: vi.fn() }
      )

      // Run both workers simultaneously
      const [resultA, resultB] = await Promise.all([
        lockedWorkerA.run(),
        lockedWorkerB.run(),
      ])

      // Only one should execute
      expect(resultA).not.toBeNull()
      expect(resultB).toBeNull()
      
      const totalExecutions = (resultA ? 1 : 0) + (resultB ? 1 : 0)
      expect(totalExecutions).toBe(1)
    })
  })

  describe('LockedAnalyticsRefreshWorker', () => {
    it('prevents duplicate analytics refresh', async () => {
      const baseWorker = makeMockAnalyticsRefreshWorker()
      const lockKey = 'cron:analytics-refresh'
      
      const lockedWorkerA = createLockedAnalyticsRefreshWorker(
        baseWorker, lockA, lockKey, { logger: vi.fn() }
      )
      const lockedWorkerB = createLockedAnalyticsRefreshWorker(
        baseWorker, lockB, lockKey, { logger: vi.fn() }
      )

      // Run both workers simultaneously
      const [resultA, resultB] = await Promise.all([
        lockedWorkerA.run(),
        lockedWorkerB.run(),
      ])

      // Only one should execute
      expect(resultA).not.toBeNull()
      expect(resultB).toBeNull()
      
      const totalExecutions = (resultA ? 1 : 0) + (resultB ? 1 : 0)
      expect(totalExecutions).toBe(1)
    })
  })

  describe('JobScheduler Integration', () => {
    it('integrates distributed lock with job scheduler', async () => {
      let executionCount = 0
      const mockJob = {
        run: vi.fn().mockImplementation(async () => {
          executionCount++
          await new Promise(resolve => setTimeout(resolve, 20))
          return { processed: 1, saved: 1, errors: 0, duration: 20, startTime: new Date().toISOString() }
        }),
      } as unknown as ScoreSnapshotJob

      const schedulerA = new JobScheduler(mockJob, {
        intervalMs: 60_000,
        runOnStart: true,
        distributedLock: lockA,
        lockKey: 'cron:scheduler-test',
      })

      const schedulerB = new JobScheduler(mockJob, {
        intervalMs: 60_000,
        runOnStart: true,
        distributedLock: lockB,
        lockKey: 'cron:scheduler-test',
      })

      // Start both schedulers simultaneously
      schedulerA.start()
      schedulerB.start()

      // Wait for both to attempt/complete
      await new Promise(resolve => setTimeout(resolve, 100))

      schedulerA.stop()
      schedulerB.stop()

      // Exactly one scheduler should have run the job
      expect(executionCount).toBe(1)
      expect(mockJob.run).toHaveBeenCalledOnce()
    })
  })

  describe('Lock Metrics and Monitoring', () => {
    it('tracks lock contention metrics', async () => {
      const jobKey = 'test:metrics-job'

      // Worker A acquires lock
      await lockA.withLock(jobKey, async () => {
        await new Promise(resolve => setTimeout(resolve, 50))
      })

      // Worker B attempts and fails (contention)
      await lockB.withLock(jobKey, async () => {
        // This shouldn't execute
      })

      const metricsA = lockA.getMetrics()
      const metricsB = lockB.getMetrics()

      expect(metricsA.acquisitions).toBe(1)
      expect(metricsA.contentions).toBe(0)
      expect(metricsB.contentions).toBe(1)
      expect(metricsB.acquisitions).toBe(0)
    })

    it('provides metrics through locked workers', async () => {
      const baseWorker = makeMockInvoiceDueDateWorker()
      const lockKey = 'test:worker-metrics'
      
      const lockedWorker = createLockedInvoiceDueDateWorker(
        baseWorker, lockA, lockKey, { logger: vi.fn() }
      )

      // Run worker to generate metrics
      await lockedWorker.run()

      const metrics = lockedWorker.getLockMetrics()
      expect(metrics.acquisitions).toBe(1)
      expect(metrics.releases).toBe(1)
    })
  })

  describe('Error Handling and Recovery', () => {
    it('releases lock even when worker throws error', async () => {
      const jobKey = 'test:error-handling'
      let executionCount = 0

      // First worker throws error
      const resultA = await lockA.withLock(jobKey, async () => {
        executionCount++
        throw new Error('Worker error')
      })

      expect(resultA.executed).toBe(true)
      await expect(resultA.result).rejects.toThrow('Worker error')

      // Second worker should be able to acquire after error
      const resultB = await lockB.withLock(jobKey, async () => {
        executionCount++
        return 'recovery-result'
      })

      expect(resultB.executed).toBe(true)
      expect(resultB.result).toBe('recovery-result')
      expect(executionCount).toBe(2)
    })

    it('handles Redis connection failures gracefully', async () => {
      const jobKey = 'test:redis-failure'
      
      // Mock Redis to throw error
      const mockRedis = {
        set: vi.fn().mockRejectedValue(new Error('Redis connection failed')),
        eval: vi.fn().mockRejectedValue(new Error('Redis connection failed')),
      } as any

      const faultyLock = new DistributedLock(mockRedis, 30_000)

      const result = await faultyLock.withLock(jobKey, async () => {
        return 'should-not-execute'
      })

      expect(result.executed).toBe(false)
      expect(result.result).toBeUndefined()
    })
  })

  describe('Performance and Scalability', () => {
    it('handles high contention efficiently', async () => {
      const jobKey = 'test:high-contention'
      const workerCount = 10
      const locks = Array.from({ length: workerCount }, () => 
        new DistributedLock(sharedRedis as any, 30_000)
      )

      let executionCount = 0

      // All workers attempt to run simultaneously
      const results = await Promise.all(
        locks.map(lock => 
          lock.withLock(jobKey, async () => {
            executionCount++
            await new Promise(resolve => setTimeout(resolve, 20))
            return `worker-${executionCount}`
          })
        )
      )

      // Only one should execute
      const successfulResults = results.filter(r => r.executed)
      expect(successfulResults).toHaveLength(1)
      expect(executionCount).toBe(1)

      // Check contention metrics
      const totalContentions = locks.reduce((sum, lock) => 
        sum + lock.getMetrics().contentions, 0
      )
      expect(totalContentions).toBe(workerCount - 1)
    })
  })
})
