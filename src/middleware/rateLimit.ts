import type { Request, Response, NextFunction } from 'express'
import { createHash } from 'crypto'
import { RedisConnection } from '../cache/redis.js'
import { AppError, ErrorCode } from '../lib/errors.js'
import type { SubscriptionTier } from '../services/apiKeys.js'
import type { Config } from '../config/index.js'

export interface RateLimitConfig {
  /** Redis key namespace */
  namespace: string
  /** Max requests allowed in the window */
  max: number
  /** Window in seconds */
  windowSec: number
  /** Function to extract tenant identifier from request */
  getTenantId?: (req: Request) => string | undefined
}

function hashIdentifier(raw: string): string {
  return createHash('sha256').update(raw).digest('hex').slice(0, 16)
}

/**
 * Extract tenant identifier from a request.
 * Prefers authenticated ownerId / tenantId, falls back to a hashed credential
 * derived from the API key or Bearer token header so that unauthenticated
 * requests are still limited per-tenant rather than purely by IP.
 */
export function getTenantId(req: Request): string | undefined {
  const apiKeyRecord = (req as any).apiKeyRecord
  if (apiKeyRecord?.ownerId) {
    return apiKeyRecord.ownerId
  }
  const user = (req as any).user
  if (user?.tenantId) {
    return user.tenantId
  }

  // Fallback: hash of the API key header
  const apiKey = req.headers['x-api-key'] as string | undefined
  if (apiKey) {
    return `ak:${hashIdentifier(apiKey)}`
  }

  // Fallback: hash of the Bearer token
  const auth = req.headers['authorization']
  if (auth?.startsWith('Bearer ')) {
    return `bt:${hashIdentifier(auth.slice(7))}`
  }

  return undefined
}

/**
 * Extract subscription tier from an authenticated request.
 */
export function getTier(req: Request): SubscriptionTier {
  const apiKeyRecord = (req as any).apiKeyRecord
  if (apiKeyRecord?.tier) {
    return apiKeyRecord.tier
  }
  // Default to free if no tier is present
  return 'free'
}

/**
 * Resolve the per-tier request limit from application config.
 */
export function resolveTierLimit(tier: SubscriptionTier, config: Config['rateLimit']): number {
  switch (tier) {
    case 'enterprise':
      return config.maxEnterprise
    case 'pro':
      return config.maxPro
    case 'free':
    default:
      return config.maxFree
  }
}

/**
 * Compose rate-limit response headers.
 */
function setRateLimitHeaders(
  res: Response,
  opts: {
    limit: number
    remaining: number
    reset: number
    retryAfter?: number
  }
): void {
  res.setHeader('X-RateLimit-Limit', String(opts.limit))
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, opts.remaining)))
  res.setHeader('X-RateLimit-Reset', String(opts.reset))
  if (opts.retryAfter !== undefined) {
    res.setHeader('Retry-After', String(opts.retryAfter))
  }
}

/**
 * Factory for tenant-level rate limiting middleware.
 *
 * - Uses Redis fixed-window counters keyed by tenant (and IP as fallback).
 * - Supports tier-based limits when integrated with API key auth.
 * - Fails open on Redis errors so that a down cache does not take the API down.
 * - Returns standard RateLimit headers on every request.
 *
 * @param config  Application rate-limit configuration
 * @param options Optional overrides (namespace, explicit max/window, custom tenant extractor)
 */
export function createRateLimitMiddleware(
  config: Config['rateLimit'],
  options?: Partial<RateLimitConfig>
) {
  const {
    namespace = 'ratelimit:api',
    windowSec = config.windowSec,
    getTenantId: customGetTenantId,
  } = options ?? {}

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!config.enabled) {
      return next()
    }

    const tenantId = customGetTenantId?.(req) ?? getTenantId(req)
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown'

    // If we cannot identify a tenant, fall back to IP-based limiting
    const keyPrefix = tenantId ? `tenant:${tenantId}` : `ip:${ip}`
    const now = Math.floor(Date.now() / 1000)
    const windowStart = now - (now % windowSec)
    const redisKey = `${namespace}:${keyPrefix}:${windowStart}`

    // Determine limit (tier-based if tenant is authenticated via API key)
    const tier = getTier(req)
    const max = options?.max ?? resolveTierLimit(tier, config)

    const resetTime = windowStart + windowSec

    try {
      const redis = RedisConnection.getInstance().getClient()
      const count = await redis.incr(redisKey)

      if (count === 1) {
        await redis.expire(redisKey, windowSec)
      }

      const remaining = max - count

      if (count > max) {
        const ttl = await redis.ttl(redisKey)
        const retryAfter = ttl > 0 ? ttl : windowSec

        setRateLimitHeaders(res, {
          limit: max,
          remaining: 0,
          reset: now + retryAfter,
          retryAfter,
        })

        next(
          new AppError(
            'Rate limit exceeded. Try again later.',
            ErrorCode.RATE_LIMIT_EXCEEDED,
            429,
            { retryAfter, limit: max, windowSec }
          )
        )
        return
      }

      setRateLimitHeaders(res, {
        limit: max,
        remaining,
        reset: resetTime,
      })

      next()
    } catch (err) {
      // Fail open: if Redis is unavailable, do not block traffic.
      if (config.failOpen) {
        setRateLimitHeaders(res, {
          limit: max,
          remaining: max,
          reset: resetTime,
        })
        return next()
      }

      // Fail closed: treat as service unavailable.
      next(
        new AppError(
          'Rate limiter unavailable',
          ErrorCode.SERVICE_UNAVAILABLE,
          503
        )
      )
    }
  }
}

