import type { IdempotencyRepository } from '../db/repositories/idempotencyRepository.js'

export interface IdempotentMessage<T = unknown> {
  messageId: string
  payload: T
  processedAt?: Date
}

export interface IdempotentResult<T = unknown> {
  success: boolean
  result?: T
  error?: string
  processedAt: Date
}

export interface IdempotentConsumerOptions {
  expiresInSeconds?: number
}

export class IdempotentConsumer<T = unknown, R = unknown> {
  private readonly repository: IdempotencyRepository

  constructor(
    private readonly db: IdempotencyRepository,
    private readonly options: IdempotentConsumerOptions = {}
  ) {
    this.repository = db
    this.options = {
      expiresInSeconds: 86400,
      ...options,
    }
  }

  async process(
    messageId: string,
    handler: () => Promise<R>
  ): Promise<IdempotentResult<R>> {
    const existing = await this.repository.findByKey(messageId)

    if (existing) {
      return {
        success: existing.responseCode < 400,
        result: existing.responseBody,
        processedAt: existing.createdAt,
      }
    }

    try {
      const result = await handler()

      await this.repository.save({
        key: messageId,
        requestHash: messageId,
        responseCode: 200,
        responseBody: result,
        expiresInSeconds: this.options.expiresInSeconds!,
      })

      return {
        success: true,
        result,
        processedAt: new Date(),
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)

      await this.repository.save({
        key: messageId,
        requestHash: messageId,
        responseCode: 500,
        responseBody: { error: errorMessage },
        expiresInSeconds: this.options.expiresInSeconds!,
      })

      return {
        success: false,
        error: errorMessage,
        processedAt: new Date(),
      }
    }
  }

  async isProcessed(messageId: string): Promise<boolean> {
    const record = await this.repository.findByKey(messageId)
    return record !== null
  }

  async getResult(messageId: string): Promise<IdempotentResult<R> | null> {
    const record = await this.repository.findByKey(messageId)
    if (!record) return null

    return {
      success: record.responseCode < 400,
      result: record.responseBody,
      processedAt: record.createdAt,
    }
  }
}

export function createIdempotentConsumer<T, R>(
  db: IdempotencyRepository,
  options?: IdempotentConsumerOptions
): IdempotentConsumer<T, R> {
  return new IdempotentConsumer(db, options)
}