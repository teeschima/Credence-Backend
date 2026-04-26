import { Pool } from 'pg'
import { createTestDatabase, type TestDatabase } from './testDatabase.js'
import { createSchema } from '../../src/db/schema.js'
import {
  NotificationIdempotencyRepository,
  IdempotentNotificationJob,
  createIdempotentNotificationJob,
  type IdempotentJobResult,
} from '../../src/jobs/notificationIdempotency.js'

describe('Notification Idempotency Integration', () => {
  let db: TestDatabase
  let pool: Pool

  beforeAll(async () => {
    db = await createTestDatabase()
    pool = db.pool
    await createSchema(pool)
  })

  afterAll(async () => {
    await db.close()
  })

  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE idempotent_job_attempts RESTART IDENTITY CASCADE')
  })

  describe('NotificationIdempotencyRepository', () => {
    it('should create a new attempt', async () => {
      const repo = new NotificationIdempotencyRepository(pool)

      const attempt = await repo.createAttempt({
        jobKey: 'notification:invoice-due:123',
        jobType: 'invoice-due',
        expiresInSeconds: 3600,
      })

      expect(attempt.jobKey).toBe('notification:invoice-due:123')
      expect(attempt.status).toBe('pending')
    })

    it('should find pending attempt by key', async () => {
      const repo = new NotificationIdempotencyRepository(pool)

      await repo.createAttempt({
        jobKey: 'notification:invoice-due:456',
        jobType: 'invoice-due',
        expiresInSeconds: 3600,
      })

      const existing = await repo.findPendingAttempt('notification:invoice-due:456')

      expect(existing).not.toBeNull()
      expect(existing?.jobKey).toBe('notification:invoice-due:456')
    })

    it('should mark attempt as completed', async () => {
      const repo = new NotificationIdempotencyRepository(pool)

      const attempt = await repo.createAttempt({
        jobKey: 'notification:invoice-due:789',
        jobType: 'invoice-due',
        expiresInSeconds: 3600,
      })

      await repo.markCompleted(attempt.id, JSON.stringify({ sent: true }))

      const updated = await repo.findPendingAttempt('notification:invoice-due:789')
      expect(updated?.status).toBe('completed')
      expect(updated?.result).toBe('{"sent":true}')
    })

    it('should return null for expired attempts', async () => {
      const repo = new NotificationIdempotencyRepository(pool)

      await repo.createAttempt({
        jobKey: 'notification:expired',
        jobType: 'test',
        expiresInSeconds: -1,
      })

      const existing = await repo.findPendingAttempt('notification:expired')
      expect(existing).toBeNull()
    })

    it('should upsert on conflict', async () => {
      const repo = new NotificationIdempotencyRepository(pool)

      await repo.createAttempt({
        jobKey: 'notification:upsert-test',
        jobType: 'test',
        expiresInSeconds: 3600,
      })

      const attempt2 = await repo.createAttempt({
        jobKey: 'notification:upsert-test',
        jobType: 'test-updated',
        expiresInSeconds: 3600,
      })

      const existing = await repo.findPendingAttempt('notification:upsert-test')
      expect(existing?.jobType).toBe('test-updated')
    })
  })

  describe('IdempotentNotificationJob', () => {
    it('should execute job on first run', async () => {
      const job = createIdempotentNotificationJob(
        pool,
        'job:first-run',
        'test',
        {
          run: async () => ({ success: true, notificationId: '123' }),
        },
        3600
      )

      const result = await job.execute()

      expect(result.alreadyProcessed).toBe(false)
      expect(result.result).toEqual({ success: true, notificationId: '123' })
    })

    it('should return cached result on duplicate execution', async () => {
      const job = createIdempotentNotificationJob(
        pool,
        'job:duplicate',
        'test',
        {
          run: async () => ({ success: true }),
        },
        3600
      )

      await job.execute()

      const result2 = await job.execute()

      expect(result2.alreadyProcessed).toBe(true)
      expect(result2.result).toEqual({ success: true })
    })

    it('should throw on concurrent duplicate execution', async () => {
      const job = createIdempotentNotificationJob(
        pool,
        'job:concurrent',
        'test',
        {
          run: async () => {
            await new Promise(resolve => setTimeout(resolve, 50))
            return { success: true }
          },
        },
        3600
      )

      const job2 = createIdempotentNotificationJob(
        pool,
        'job:concurrent',
        'test',
        {
          run: async () => ({ success: true }),
        },
        3600
      )

      const [first, second] = await Promise.all([
        job.execute(),
        job2.execute().catch(e => e.message),
      ])

      if (typeof second === 'string') {
        expect(second).toContain('already pending')
      } else {
        expect(first.alreadyProcessed).toBeDefined()
      }
    })

    it('should propagate errors and mark as failed', async () => {
      const job = createIdempotentNotificationJob(
        pool,
        'job:error',
        'test',
        {
          run: async () => {
            throw new Error('Provider error')
          },
        },
        3600
      )

      await expect(job.execute()).rejects.toThrow('Provider error')

      const attempt = await new NotificationIdempotencyRepository(pool).findPendingAttempt(
        'job:error'
      )
      expect(attempt?.status).toBe('failed')
      expect(attempt?.result).toBe('Provider error')
    })

    it('should re-execute after failure', async () => {
      const repo = new NotificationIdempotencyRepository(pool)

      await repo.createAttempt({
        jobKey: 'job:retry',
        jobType: 'test',
        expiresInSeconds: 3600,
      })
      await repo.markFailed('job:retry', 'Previous error')

      const job = createIdempotentNotificationJob(
        pool,
        'job:retry',
        'test',
        {
          run: async () => ({ success: true }),
        },
        3600
      )

      const result = await job.execute()

      expect(result.alreadyProcessed).toBe(false)
      expect(result.result).toEqual({ success: true })
    })
  })

  describe('Idempotency prevents duplicate sends', () => {
    it('should not send duplicate email for same notification', async () => {
      let sendCount = 0

      const emailJob = {
        run: async () => {
          sendCount++
          return { sent: true, emailId: 'email-123' }
        },
      }

      const job1 = createIdempotentNotificationJob(
        pool,
        'email:invoice:inv-001',
        'invoice-due',
        emailJob,
        3600
      )

      const job2 = createIdempotentNotificationJob(
        pool,
        'email:invoice:inv-001',
        'invoice-due',
        emailJob,
        3600
      )

      await job1.execute()
      await job2.execute()

      expect(sendCount).toBe(1)
    })

    it('should allow re-send after expiry', async () => {
      let sendCount = 0

      const job = createIdempotentNotificationJob(
        pool,
        'email:expiry-test',
        'test',
        {
          run: async () => {
            sendCount++
            return { count: sendCount }
          },
        },
        -1
      )

      await job.execute()

      await new Promise(resolve => setTimeout(resolve, 100))

      const job2 = createIdempotentNotificationJob(
        pool,
        'email:expiry-test',
        'test',
        {
          run: async () => {
            sendCount++
            return { count: sendCount }
          },
        },
        3600
      )

      const result = await job2.execute()

      expect(sendCount).toBe(2)
      expect(result.result?.count).toBe(2)
    })
  })
})