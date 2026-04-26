import type { Pool, PoolClient } from 'pg'

/** PostgreSQL error code emitted when lock_timeout fires (lock_not_available). */
export const PG_LOCK_TIMEOUT_CODE = '55P03'

/**
 * Named timeout policies that map to pre-configured millisecond values.
 * Choose the least-permissive policy that still meets the operation's SLA
 * to bound contention impact on other callers.
 */
export enum LockTimeoutPolicy {
  READONLY = 'readonly',
  DEFAULT = 'default',
  CRITICAL = 'critical',
}

/** Thrown when a row lock cannot be acquired within the configured window. */
export class LockTimeoutError extends Error {
  constructor(
    /** The named policy active at the time of the timeout, if any. */
    public readonly policy: LockTimeoutPolicy | undefined,
    /** Effective timeout in milliseconds that was applied. */
    public readonly timeoutMs: number
  ) {
    super(`Lock timeout after ${timeoutMs}ms (policy: ${policy ?? 'custom'})`)
    this.name = 'LockTimeoutError'
  }
}

export interface LockTimeoutConfig {
  readonly: number
  default: number
  critical: number
}

export interface TransactionOptions {
  policy?: LockTimeoutPolicy
  timeoutMs?: number
  isolationLevel?: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE'
  retryOnLockTimeout?: boolean
  maxRetries?: number
  retryDelayMs?: number
}

const FALLBACK_TIMEOUTS: LockTimeoutConfig = {
  readonly: 2_000,
  default: 5_000,
  critical: 10_000,
}

/**
 * Manages PostgreSQL transactions with configurable lock-timeout policies
 * and optional exponential-backoff retry on contention.
 *
 * Pass the PoolClient received by the withTransaction callback to every
 * repository that must participate in the same atomic unit. All writes share
 * one client connection under a single BEGIN...COMMIT block. Any uncaught
 * error triggers an immediate ROLLBACK so partial state is never committed,
 * even across multiple nested service calls.
 */
export class TransactionManager {
  private readonly timeouts: LockTimeoutConfig

  constructor(
    private readonly pool: Pool,
    timeouts?: Partial<LockTimeoutConfig>
  ) {
    this.timeouts = { ...FALLBACK_TIMEOUTS, ...timeouts }
  }

  /**
   * Execute fn atomically inside a PostgreSQL transaction.
   *
   * Forward the supplied PoolClient to every repository participating in
   * this transaction so nested calls share the same BEGIN...COMMIT block and
   * roll back together on any error.
   *
   * @param fn      - Callback receiving an exclusive PoolClient.
   * @param options - Timeout policy, isolation level, and retry config.
   * @returns The value returned by fn after a successful commit.
   * @throws {LockTimeoutError} when a row lock cannot be acquired in time.
   */
  async withTransaction<T>(
    fn: (client: PoolClient) => Promise<T>,
    options: TransactionOptions = {}
  ): Promise<T> {
    const {
      policy,
      timeoutMs,
      isolationLevel,
      retryOnLockTimeout = false,
      maxRetries = 3,
      retryDelayMs = 100,
    } = options

    const effectiveTimeoutMs =
      timeoutMs ?? (policy !== undefined ? this.timeouts[policy] : this.timeouts.default)

    let attempts = 0

    while (true) {
      const client = await this.pool.connect()

      try {
        const beginSql = isolationLevel
          ? `BEGIN ISOLATION LEVEL ${isolationLevel}`
          : 'BEGIN'

        await client.query(beginSql)
        await client.query(`SET LOCAL lock_timeout = '${effectiveTimeoutMs}ms'`)

        const result = await fn(client)

        await client.query('COMMIT')
        return result
      } catch (err: unknown) {
        await client.query('ROLLBACK').catch(() => {
          // Swallowed: connection may be dead, pg will recycle on release.
        })

        const pgCode = (err as { code?: string }).code

        if (pgCode === PG_LOCK_TIMEOUT_CODE) {
          if (retryOnLockTimeout && attempts < maxRetries) {
            const delay = retryDelayMs * Math.pow(2, attempts)
            attempts++
            await sleep(delay)
            continue
          }

          throw new LockTimeoutError(policy, effectiveTimeoutMs)
        }

        throw err
      } finally {
        client.release()
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
