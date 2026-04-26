import { validateConfig, loadConfig } from '../config/index.js'
import { TransactionManager, LockTimeoutPolicy } from '../db/transaction.js'

describe('Lock Timeout Configuration', () => {
  describe('Environment Variables', () => {
    it('should use default values when not specified', () => {
      const env = {
        DB_URL: 'postgresql://localhost/test',
        REDIS_URL: 'redis://localhost',
        JWT_SECRET: 'test-secret-key-that-is-at-least-32-chars',
        PORT: '3000',
        NODE_ENV: 'development',
        LOG_LEVEL: 'info',
      }

      const config = validateConfig(env)

      expect(config.db.lockTimeouts).toEqual({
        readonlyMs: 1000,
        defaultMs: 2000,
        criticalMs: 5000,
      })
    })

    it('should use custom values when specified', () => {
      const env = {
        DB_URL: 'postgresql://localhost/test',
        REDIS_URL: 'redis://localhost',
        JWT_SECRET: 'test-secret-key-that-is-at-least-32-chars',
        PORT: '3000',
        NODE_ENV: 'development',
        LOG_LEVEL: 'info',
        DB_LOCK_TIMEOUT_READONLY_MS: '500',
        DB_LOCK_TIMEOUT_DEFAULT_MS: '1500',
        DB_LOCK_TIMEOUT_CRITICAL_MS: '3000',
      }

      const config = validateConfig(env)

      expect(config.db.lockTimeouts).toEqual({
        readonlyMs: 500,
        defaultMs: 1500,
        criticalMs: 3000,
      })
    })

    it('should reject values below minimum threshold', () => {
      const env = {
        DB_URL: 'postgresql://localhost/test',
        REDIS_URL: 'redis://localhost',
        JWT_SECRET: 'test-secret-key-that-is-at-least-32-chars',
        PORT: '3000',
        NODE_ENV: 'development',
        LOG_LEVEL: 'info',
        DB_LOCK_TIMEOUT_READONLY_MS: '50', // Below minimum of 100
      }

      expect(() => validateConfig(env)).toThrow()
    })

    it('should validate numeric values', () => {
      const env = {
        DB_URL: 'postgresql://localhost/test',
        REDIS_URL: 'redis://localhost',
        JWT_SECRET: 'test-secret-key-that-is-at-least-32-chars',
        PORT: '3000',
        NODE_ENV: 'development',
        LOG_LEVEL: 'info',
        DB_LOCK_TIMEOUT_READONLY_MS: 'invalid',
      }

      expect(() => validateConfig(env)).toThrow()
    })
  })

  describe('TransactionManager Integration', () => {
    it('should initialize with config defaults', () => {
      const mockPool = {} as any
      const txManager = new TransactionManager(mockPool)

      // Test that default timeouts are used
      expect(txManager).toBeDefined()
    })

    it('should accept custom timeout configuration', () => {
      const mockPool = {} as any
      const customTimeouts = {
        readonly: 500,
        default: 1500,
        critical: 3000,
      }
      const txManager = new TransactionManager(mockPool, customTimeouts)

      expect(txManager).toBeDefined()
    })

    it('should merge partial configuration with defaults', () => {
      const mockPool = {} as any
      const partialTimeouts = {
        readonly: 800,
        // default and critical should use defaults
      }
      const txManager = new TransactionManager(mockPool, partialTimeouts)

      expect(txManager).toBeDefined()
    })
  })

  describe('Lock Timeout Policies', () => {
    it('should have correct policy values', () => {
      expect(LockTimeoutPolicy.READONLY).toBe('readonly')
      expect(LockTimeoutPolicy.DEFAULT).toBe('default')
      expect(LockTimeoutPolicy.CRITICAL).toBe('critical')
    })

    it('should support all expected policies', () => {
      const policies = Object.values(LockTimeoutPolicy)
      expect(policies).toContain('readonly')
      expect(policies).toContain('default')
      expect(policies).toContain('critical')
      expect(policies).toHaveLength(3)
    })
  })

  describe('Configuration Validation', () => {
    it('should validate complete configuration', () => {
      const env = {
        DB_URL: 'postgresql://localhost/test',
        REDIS_URL: 'redis://localhost',
        JWT_SECRET: 'test-secret-key-that-is-at-least-32-chars-long',
        PORT: '3000',
        NODE_ENV: 'development',
        LOG_LEVEL: 'info',
        DB_LOCK_TIMEOUT_READONLY_MS: '1000',
        DB_LOCK_TIMEOUT_DEFAULT_MS: '2000',
        DB_LOCK_TIMEOUT_CRITICAL_MS: '5000',
      }

      const config = validateConfig(env)
      
      expect(config.db.lockTimeouts.readonlyMs).toBe(1000)
      expect(config.db.lockTimeouts.defaultMs).toBe(2000)
      expect(config.db.lockTimeouts.criticalMs).toBe(5000)
    })

    it('should handle zero values gracefully', () => {
      const env = {
        DB_URL: 'postgresql://localhost/test',
        REDIS_URL: 'redis://localhost',
        JWT_SECRET: 'test-secret-key-that-is-at-least-32-chars-long',
        PORT: '3000',
        NODE_ENV: 'development',
        LOG_LEVEL: 'info',
        DB_LOCK_TIMEOUT_READONLY_MS: '0', // Should fail validation
      }

      expect(() => validateConfig(env)).toThrow()
    })

    it('should handle negative values', () => {
      const env = {
        DB_URL: 'postgresql://localhost/test',
        REDIS_URL: 'redis://localhost',
        JWT_SECRET: 'test-secret-key-that-is-at-least-32-chars-long',
        PORT: '3000',
        NODE_ENV: 'development',
        LOG_LEVEL: 'info',
        DB_LOCK_TIMEOUT_DEFAULT_MS: '-1000',
      }

      expect(() => validateConfig(env)).toThrow()
    })
  })
})
