import type { Queryable } from '../repositories/queryable.js'
import type { OutboxEvent, CreateOutboxEvent, OutboxEventStatus, OutboxCleanupConfig } from './types.js'

/**
 * Repository for transactional outbox events.
 * All methods accept a Queryable (Pool or PoolClient) to support transactions.
 */
export class OutboxRepository {
  /**
   * Insert a new event into the outbox within a transaction.
   * This ensures the event is persisted atomically with business state changes.
   */
  async create(db: Queryable, event: CreateOutboxEvent): Promise<bigint> {
    const result = await db.query<{ id: string }>(
      `INSERT INTO event_outbox (aggregate_type, aggregate_id, event_type, payload, status, max_retries)
       VALUES ($1, $2, $3, $4, 'pending', $5)
       RETURNING id`,
      [
        event.aggregateType,
        event.aggregateId,
        event.eventType,
        JSON.stringify(event.payload),
        event.maxRetries ?? 5,
      ]
    )
    return BigInt(result.rows[0].id)
  }

  /**
   * Claim events for processing by a specific consumer with a lease.
   * Events are atomically marked as 'processing' and assigned to the consumer.
   * This method supports crash recovery: stale claims (expired lease) can be reclaimed.
   *
   * @param db - Database connection
   * @param consumerId - Unique identifier for the consumer
   * @param limit - Maximum number of events to claim
   * @param leaseSeconds - Lease duration in seconds
   * @returns Array of claimed events ordered by creation time
   */
  async claimEvents(
    db: Queryable,
    consumerId: string,
    limit: number = 100,
    leaseSeconds: number = 300
  ): Promise<OutboxEvent[]> {
    // Try with SKIP LOCKED first (real PostgreSQL)
    try {
      const result = await db.query<{
        id: string
        aggregate_type: string
        aggregate_id: string
        event_type: string
        payload: string | Record<string, unknown>
        status: OutboxEventStatus
        retry_count: number
        max_retries: number
        created_at: string
        processed_at: string | null
        error_message: string | null
        consumer_id: string | null
        lease_expires_at: string | null
      }>(
        `UPDATE event_outbox
         SET status = 'processing',
             consumer_id = $2,
             lease_expires_at = NOW() + ($3 || ' seconds')::interval
         WHERE id IN (
           SELECT id FROM event_outbox
           WHERE status = 'pending'
              OR (status = 'processing' AND (lease_expires_at IS NULL OR lease_expires_at < NOW()))
           ORDER BY created_at ASC
           LIMIT $1
           FOR UPDATE SKIP LOCKED
         )
         RETURNING id, aggregate_type, aggregate_id, event_type, payload, status,
                   retry_count, max_retries, created_at, processed_at, error_message,
                   consumer_id, lease_expires_at`,
        [limit, consumerId, leaseSeconds.toString()]
      )

      return result.rows.map(row => ({
        id: BigInt(row.id),
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        eventType: row.event_type,
        payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
        status: row.status,
        retryCount: row.retry_count,
        maxRetries: row.max_retries,
        consumerId: row.consumer_id,
        leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at) : null,
        createdAt: new Date(row.created_at),
        processedAt: row.processed_at ? new Date(row.processed_at) : null,
        errorMessage: row.error_message,
      }))
    } catch (error) {
      // Fallback for pg-mem (doesn't support SKIP LOCKED)
      const result = await db.query<{
        id: string
        aggregate_type: string
        aggregate_id: string
        event_type: string
        payload: string | Record<string, unknown>
        status: OutboxEventStatus
        retry_count: number
        max_retries: number
        created_at: string
        processed_at: string | null
        error_message: string | null
        consumer_id: string | null
        lease_expires_at: string | null
      }>(
        `UPDATE event_outbox
         SET status = 'processing',
             consumer_id = $2,
             lease_expires_at = NOW() + ($3 || ' seconds')::interval
         WHERE id IN (
           SELECT id FROM event_outbox
           WHERE status = 'pending'
              OR (status = 'processing' AND (lease_expires_at IS NULL OR lease_expires_at < NOW()))
           ORDER BY created_at ASC
           LIMIT $1
         )
         RETURNING id, aggregate_type, aggregate_id, event_type, payload, status,
                   retry_count, max_retries, created_at, processed_at, error_message,
                   consumer_id, lease_expires_at`,
        [limit, consumerId, leaseSeconds.toString()]
      )

      return result.rows.map(row => ({
        id: BigInt(row.id),
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        eventType: row.event_type,
        payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
        status: row.status,
        retryCount: row.retry_count,
        maxRetries: row.max_retries,
        consumerId: row.consumer_id,
        leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at) : null,
        createdAt: new Date(row.created_at),
        processedAt: row.processed_at ? new Date(row.processed_at) : null,
        errorMessage: row.error_message,
      }))
    }
  }

  /**
   * Renew the lease on events currently claimed by the consumer.
   * Extends lease_expires_at for all processing events owned by this consumer.
   *
   * @param db - Database connection
   * @param consumerId - Consumer identifier
   * @param leaseSeconds - New lease duration in seconds
   * @returns Number of events whose lease was renewed
   */
  async renewLease(db: Queryable, consumerId: string, leaseSeconds: number): Promise<number> {
    const result = await db.query(
      `UPDATE event_outbox
       SET lease_expires_at = NOW() + ($2 || ' seconds')::interval
       WHERE consumer_id = $1 AND status = 'processing'`,
      [consumerId, leaseSeconds.toString()]
    )
    return (result as any).rowCount ?? 0
  }

  /**
   * Release all claims for a consumer (graceful shutdown).
   * Resets events claimed by this consumer back to 'pending'.
   *
   * @param db - Database connection
   * @param consumerId - Consumer identifier
   * @returns Number of events released
   */
  async releaseClaims(db: Queryable, consumerId: string): Promise<number> {
    const result = await db.query<{ count: string }>(
      `UPDATE event_outbox
       SET status = 'pending', consumer_id = NULL, lease_expires_at = NULL
       WHERE consumer_id = $1 AND status = 'processing'`,
      [consumerId]
    )
    const rowCount = (result as any).rowCount ?? result.rows?.[0]?.count
    return typeof rowCount === 'number' ? rowCount : 0
  }

  /**
   * Fetch events currently assigned to a consumer (for recovery/resume).
   *
   * @param db - Database connection
   * @param consumerId - Consumer identifier
   * @param limit - Maximum events to fetch
   * @returns Array of events owned by this consumer with status 'processing'
   */
  async fetchByConsumer(db: Queryable, consumerId: string, limit: number = 100): Promise<OutboxEvent[]> {
    const result = await db.query<{
      id: string
      aggregate_type: string
      aggregate_id: string
      event_type: string
      payload: string | Record<string, unknown>
      status: OutboxEventStatus
      retry_count: number
      max_retries: number
      created_at: string
      processed_at: string | null
      error_message: string | null
      consumer_id: string | null
      lease_expires_at: string | null
    }>(
      `SELECT id, aggregate_type, aggregate_id, event_type, payload, status,
              retry_count, max_retries, created_at, processed_at, error_message,
              consumer_id, lease_expires_at
       FROM event_outbox
       WHERE consumer_id = $1 AND status = 'processing'
       ORDER BY created_at ASC
       LIMIT $2`,
      [consumerId, limit]
    )

    return result.rows.map(row => ({
      id: BigInt(row.id),
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      eventType: row.event_type,
      payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
      status: row.status,
      retryCount: row.retry_count,
      maxRetries: row.max_retries,
      consumerId: row.consumer_id,
      leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at) : null,
      createdAt: new Date(row.created_at),
      processedAt: row.processed_at ? new Date(row.processed_at) : null,
      errorMessage: row.error_message,
    }))
  }

  /**
   * Deprecated: Use claimEvents instead for crash-safe processing with consumer tracking.
   */
  async fetchPendingForProcessing(db: Queryable, limit: number = 100): Promise<OutboxEvent[]> {
    // Legacy behavior maintained for backward compatibility.
    // New code should use claimEvents().
    try {
      const result = await db.query<{
        id: string
        aggregate_type: string
        aggregate_id: string
        event_type: string
        payload: string | Record<string, unknown>
        status: OutboxEventStatus
        retry_count: number
        max_retries: number
        created_at: string
        processed_at: string | null
        error_message: string | null
      }>(
        `UPDATE event_outbox
         SET status = 'processing'
         WHERE id IN (
           SELECT id FROM event_outbox
           WHERE status = 'pending'
           ORDER BY created_at ASC
           LIMIT $1
           FOR UPDATE SKIP LOCKED
         )
         RETURNING id, aggregate_type, aggregate_id, event_type, payload, status, 
                   retry_count, max_retries, created_at, processed_at, error_message`,
        [limit]
      )

      return result.rows.map(row => ({
        id: BigInt(row.id),
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        eventType: row.event_type,
        payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
        status: row.status,
        retryCount: row.retry_count,
        maxRetries: row.max_retries,
        createdAt: new Date(row.created_at),
        processedAt: row.processed_at ? new Date(row.processed_at) : null,
        errorMessage: row.error_message,
      }))
    } catch (error) {
      // Fallback for pg-mem
      const result = await db.query<{
        id: string
        aggregate_type: string
        aggregate_id: string
        event_type: string
        payload: string | Record<string, unknown>
        status: OutboxEventStatus
        retry_count: number
        max_retries: number
        created_at: string
        processed_at: string | null
        error_message: string | null
      }>(
        `UPDATE event_outbox
         SET status = 'processing'
         WHERE id IN (
           SELECT id FROM event_outbox
           WHERE status = 'pending'
           ORDER BY created_at ASC
           LIMIT $1
         )
         RETURNING id, aggregate_type, aggregate_id, event_type, payload, status, 
                   retry_count, max_retries, created_at, processed_at, error_message`,
        [limit]
      )

      return result.rows.map(row => ({
        id: BigInt(row.id),
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        eventType: row.event_type,
        payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
        status: row.status,
        retryCount: row.retry_count,
        maxRetries: row.max_retries,
        createdAt: new Date(row.created_at),
        processedAt: row.processed_at ? new Date(row.processed_at) : null,
        errorMessage: row.error_message,
      }))
    }
  }

  /**
   * Mark an event as successfully published.
   */
  async markPublished(db: Queryable, eventId: bigint): Promise<void> {
    await db.query(
      `UPDATE event_outbox
       SET status = 'published', processed_at = NOW(), consumer_id = NULL, lease_expires_at = NULL
       WHERE id = $1`,
      [eventId.toString()]
    )
  }

  /**
   * Mark an event as failed and increment retry count.
   * If max retries exceeded, status remains 'failed'.
   */
  async markFailed(db: Queryable, eventId: bigint, errorMessage: string): Promise<void> {
    await db.query(
      `UPDATE event_outbox
       SET status = CASE 
         WHEN retry_count + 1 >= max_retries THEN 'failed'
         ELSE 'pending'
       END,
           retry_count = retry_count + 1,
           error_message = $2,
           processed_at = CASE 
         WHEN retry_count + 1 >= max_retries THEN NOW()
         ELSE NULL
       END,
           consumer_id = NULL,
           lease_expires_at = NULL
       WHERE id = $1`,
      [eventId.toString(), errorMessage]
    )
  }

  /**
   * Get events for a specific aggregate, ordered by creation time.
   * Useful for maintaining ordering guarantees per aggregate.
   */
  async getByAggregate(
    db: Queryable,
    aggregateType: string,
    aggregateId: string,
    limit: number = 100
  ): Promise<OutboxEvent[]> {
    const result = await db.query<{
      id: string
      aggregate_type: string
      aggregate_id: string
      event_type: string
      payload: string | Record<string, unknown>
      status: OutboxEventStatus
      retry_count: number
      max_retries: number
      created_at: string
      processed_at: string | null
      error_message: string | null
      consumer_id: string | null
      lease_expires_at: string | null
    }>(
      `SELECT id, aggregate_type, aggregate_id, event_type, payload, status,
              retry_count, max_retries, created_at, processed_at, error_message,
              consumer_id, lease_expires_at
       FROM event_outbox
       WHERE aggregate_type = $1 AND aggregate_id = $2
       ORDER BY created_at DESC
       LIMIT $3`,
      [aggregateType, aggregateId, limit]
    )

    return result.rows.map(row => ({
      id: BigInt(row.id),
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      eventType: row.event_type,
      payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
      status: row.status,
      retryCount: row.retry_count,
      maxRetries: row.max_retries,
      consumerId: row.consumer_id,
      leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at) : null,
      createdAt: new Date(row.created_at),
      processedAt: row.processed_at ? new Date(row.processed_at) : null,
      errorMessage: row.error_message,
    }))
  }

  /**
   * Clean up old published and failed events based on retention policy.
   */
  async cleanup(db: Queryable, config: OutboxCleanupConfig): Promise<number> {
    const result = await db.query<{ deleted_count: number }>(
      `WITH deleted AS (
         DELETE FROM event_outbox
         WHERE (status = 'published' AND processed_at < NOW() - ($1 || ' days')::interval)
            OR (status = 'failed' AND processed_at < NOW() - ($2 || ' days')::interval)
         RETURNING id
       )
       SELECT COUNT(*) as deleted_count FROM deleted`,
      [config.publishedRetentionDays, config.failedRetentionDays]
    )
    return result.rows[0]?.deleted_count ?? 0
  }

  /**
   * Get statistics about outbox events.
   */
  async getStats(db: Queryable): Promise<{
    pending: number
    processing: number
    published: number
    failed: number
  }> {
    const result = await db.query<{ status: OutboxEventStatus; count: string }>(
      `SELECT status, COUNT(*) as count
       FROM event_outbox
       GROUP BY status`
    )

    const stats = { pending: 0, processing: 0, published: 0, failed: 0 }
    for (const row of result.rows) {
      stats[row.status] = parseInt(row.count, 10)
    }
    return stats
  }
}
