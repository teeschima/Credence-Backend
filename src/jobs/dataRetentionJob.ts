/**
 * DataRetentionJob
 *
 * Enforces org-level data retention by pruning records that exceed their TTL
 * from each configured entity table.  The job supports:
 *
 *   - Per-entity configurable TTL (0 = keep forever)
 *   - Dry-run mode: logs what *would* be deleted without mutating the DB
 *   - Structured audit output per run (entity, count, dryRun flag)
 *   - Batch limits to avoid locking large tables
 */

import type { RetentionConfig } from '../config/retention.js'
import { RetentionRepository } from '../repositories/retentionRepository.js'
import type { Queryable } from '../db/repositories/queryable.js'

export interface RetentionEntityAudit {
  entity: string
  expiredCount: number
  deletedCount: number
  ttlDays: number
  dryRun: boolean
}

export interface DataRetentionResult {
  startTime: string
  duration: number
  dryRun: boolean
  entities: RetentionEntityAudit[]
  totalDeleted: number
  totalExpired: number
}

export class DataRetentionJob {
  private readonly repo: RetentionRepository
  private readonly logger: (msg: string) => void

  constructor(
    private readonly db: Queryable,
    private readonly config: RetentionConfig,
    logger?: (msg: string) => void,
  ) {
    this.repo = new RetentionRepository(db, config.dryRun)
    this.logger = logger ?? (() => {})
  }

  async run(): Promise<DataRetentionResult> {
    const start = Date.now()
    const startTime = new Date().toISOString()
    const { dryRun, batchLimit, entities } = this.config

    this.logger(
      `[retention] Starting run — dryRun=${dryRun} batchLimit=${batchLimit}`,
    )

    const audits: RetentionEntityAudit[] = await Promise.all([
      this.processEntity(
        'score_history',
        entities.scoreHistory.ttlDays,
        batchLimit,
        () => this.repo.countExpiredScoreHistory(entities.scoreHistory.ttlDays),
        () => this.repo.deleteExpiredScoreHistory(entities.scoreHistory.ttlDays, batchLimit),
      ),
      this.processEntity(
        'audit_logs',
        entities.auditLogs.ttlDays,
        batchLimit,
        () => this.repo.countExpiredAuditLogs(entities.auditLogs.ttlDays),
        () => this.repo.deleteExpiredAuditLogs(entities.auditLogs.ttlDays, batchLimit),
      ),
      this.processEntity(
        'slash_events',
        entities.slashEvents.ttlDays,
        batchLimit,
        () => this.repo.countExpiredSlashEvents(entities.slashEvents.ttlDays),
        () => this.repo.deleteExpiredSlashEvents(entities.slashEvents.ttlDays, batchLimit),
      ),
      this.processEntity(
        'outbox_events',
        entities.outboxEvents.ttlDays,
        batchLimit,
        () => this.repo.countExpiredOutboxEvents(entities.outboxEvents.ttlDays),
        () => this.repo.deleteExpiredOutboxEvents(entities.outboxEvents.ttlDays, batchLimit),
      ),
    ])

    const totalDeleted = audits.reduce((sum, a) => sum + a.deletedCount, 0)
    const totalExpired = audits.reduce((sum, a) => sum + a.expiredCount, 0)
    const duration = Date.now() - start

    this.logger(
      `[retention] Run complete — totalExpired=${totalExpired} totalDeleted=${totalDeleted} duration=${duration}ms`,
    )

    return { startTime, duration, dryRun, entities: audits, totalDeleted, totalExpired }
  }

  private async processEntity(
    name: string,
    ttlDays: number,
    batchLimit: number,
    countFn: () => Promise<{ expiredCount: number }>,
    deleteFn: () => Promise<{ deletedCount: number; dryRun: boolean }>,
  ): Promise<RetentionEntityAudit> {
    if (ttlDays === 0) {
      this.logger(`[retention] ${name} — ttlDays=0, skipping`)
      return { entity: name, expiredCount: 0, deletedCount: 0, ttlDays: 0, dryRun: this.config.dryRun }
    }

    const { expiredCount } = await countFn()

    this.logger(
      `[retention] ${name} — ttlDays=${ttlDays} expiredCount=${expiredCount}${this.config.dryRun ? ' (dry-run)' : ''}`,
    )

    if (expiredCount === 0) {
      return { entity: name, expiredCount: 0, deletedCount: 0, ttlDays, dryRun: this.config.dryRun }
    }

    const { deletedCount, dryRun } = await deleteFn()

    if (!dryRun) {
      this.logger(`[retention] ${name} — deleted ${deletedCount} rows`)
    }

    return { entity: name, expiredCount, deletedCount, ttlDays, dryRun }
  }
}
