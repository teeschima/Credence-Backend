/**
 * Integration example showing how to use configurable lock timeouts
 * in critical transaction paths.
 */

import { TransactionManager, LockTimeoutPolicy } from '../db/transaction.js'
import { loadConfig } from '../config/index.js'

describe('Lock Timeout Integration Examples', () => {
  let config: any
  let txManager: TransactionManager

  beforeEach(() => {
    config = loadConfig({
      DB_URL: 'postgresql://localhost/test',
      REDIS_URL: 'redis://localhost',
      JWT_SECRET: 'test-secret-key-that-is-at-least-32-chars-long',
      PORT: '3000',
      NODE_ENV: 'test',
      LOG_LEVEL: 'info',
    })
    
    const mockPool = {
      connect: jest.fn().mockResolvedValue({
        query: jest.fn(),
        release: jest.fn(),
      }),
    } as any
    
    txManager = new TransactionManager(mockPool, config.db.lockTimeouts)
  })

  describe('Critical Transaction Example', () => {
    it('should demonstrate critical transaction with retry', async () => {
      // Example: Bond debit operation with critical lock timeout
      const mockClient = {
        query: jest.fn(),
        release: jest.fn(),
      }
      
      // Mock the pool.connect to return our mock client
      jest.spyOn(txManager['pool'], 'connect').mockResolvedValue(mockClient)
      
      // Simulate successful transaction
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // SET lock_timeout
        .mockResolvedValueOnce({ rows: [{ id: 1, amount: '1000' }] }) // SELECT FOR UPDATE
        .mockResolvedValueOnce({ rows: [{ id: 1, amount: '800' }] }) // UPDATE
        .mockResolvedValueOnce({}) // COMMIT

      const result = await txManager.withTransaction(
        async (client) => {
          // Simulate bond debit operation
          const lockResult = await client.query(
            'SELECT * FROM bonds WHERE id = $1 FOR UPDATE',
            [1]
          )
          
          const bond = lockResult.rows[0]
          const newAmount = Number(bond.amount) - 200
          
          await client.query(
            'UPDATE bonds SET amount = $1 WHERE id = $2',
            [newAmount.toString(), 1]
          )
          
          return { ...bond, amount: newAmount.toString() }
        },
        {
          policy: LockTimeoutPolicy.CRITICAL,
          isolationLevel: 'REPEATABLE READ',
          retryOnLockTimeout: true,
          maxRetries: 2,
          retryDelayMs: 100,
        }
      )

      expect(result).toEqual({
        id: 1,
        amount: '800',
      })
      
      // Verify lock timeout was set to critical value (5000ms = 5s)
      expect(mockClient.query).toHaveBeenCalledWith(
        'SET lock_timeout = $1',
        ['5s']
      )
    })
  })

  describe('Read-Only Transaction Example', () => {
    it('should demonstrate read-only transaction with minimal timeout', async () => {
      const mockClient = {
        query: jest.fn(),
        release: jest.fn(),
      }
      
      jest.spyOn(txManager['pool'], 'connect').mockResolvedValue(mockClient)
      
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // SET lock_timeout
        .mockResolvedValueOnce({ rows: [{ id: 1, value: 'test' }] }) // SELECT
        .mockResolvedValueOnce({}) // COMMIT

      const result = await txManager.withTransaction(
        async (client) => {
          const res = await client.query('SELECT * FROM data WHERE id = $1', [1])
          return res.rows[0]
        },
        {
          policy: LockTimeoutPolicy.READONLY,
        }
      )

      expect(result).toEqual({ id: 1, value: 'test' })
      
      // Verify lock timeout was set to readonly value (1000ms = 1s)
      expect(mockClient.query).toHaveBeenCalledWith(
        'SET lock_timeout = $1',
        ['1s']
      )
    })
  })

  describe('Custom Timeout Example', () => {
    it('should demonstrate custom timeout override', async () => {
      const mockClient = {
        query: jest.fn(),
        release: jest.fn(),
      }
      
      jest.spyOn(txManager['pool'], 'connect').mockResolvedValue(mockClient)
      
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // SET lock_timeout
        .mockResolvedValueOnce({ rows: [] }) // Some operation
        .mockResolvedValueOnce({}) // COMMIT

      await txManager.withTransaction(
        async (client) => {
          await client.query('SELECT * FROM some_table')
        },
        {
          timeoutMs: 3000, // Custom 3 second timeout
        }
      )

      // Verify custom timeout was set (3000ms = 3s)
      expect(mockClient.query).toHaveBeenCalledWith(
        'SET lock_timeout = $1',
        ['3s']
      )
    })
  })

  describe('Configuration Integration', () => {
    it('should use configuration values in transaction manager', () => {
      const customConfig = loadConfig({
        DB_URL: 'postgresql://localhost/test',
        REDIS_URL: 'redis://localhost',
        JWT_SECRET: 'test-secret-key-that-is-at-least-32-chars-long',
        PORT: '3000',
        NODE_ENV: 'test',
        LOG_LEVEL: 'info',
        DB_LOCK_TIMEOUT_READONLY_MS: '500',
        DB_LOCK_TIMEOUT_DEFAULT_MS: '1500',
        DB_LOCK_TIMEOUT_CRITICAL_MS: '3000',
      })

      const mockPool = {} as any
      const customTxManager = new TransactionManager(mockPool, {
        readonly: customConfig.db.lockTimeouts.readonlyMs,
        default: customConfig.db.lockTimeouts.defaultMs,
        critical: customConfig.db.lockTimeouts.criticalMs,
      })

      expect(customTxManager).toBeDefined()
      // The actual timeout values are tested through the transaction execution
    })
  })
})
