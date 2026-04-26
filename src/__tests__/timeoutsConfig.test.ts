import { describe, it, expect } from 'vitest'
import { validateConfig } from '../config/index.js'

describe('Timeout Configuration', () => {
  it('parses timeout environment variables correctly', () => {
    const env = {
      // Required base vars
      PORT: '3000',
      DB_URL: 'postgres://localhost/db',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: '12345678901234567890123456789012',
      // Timeouts
      TIMEOUT_DB_MS: '3000',
      TIMEOUT_SOROBAN_MS: '6000',
    }

    const config = validateConfig(env)

    expect(config.timeouts.db).toBe(3000)
    expect(config.timeouts.soroban).toBe(6000)
    // Unset values should be undefined so they can fall back to lib/timeouts.ts defaults downstream
    expect(config.timeouts.http).toBeUndefined()
    expect(config.timeouts.webhook).toBeUndefined()
  })
})
