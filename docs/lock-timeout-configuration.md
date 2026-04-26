# Configurable Lock Timeout for Critical Transactions

This document describes the implementation of configurable lock timeout for critical transaction paths in the Credence backend.

## Overview

The lock timeout system allows fine-grained control over database lock timeouts for different transaction types, providing safe defaults and enabling optimization for various operational scenarios.

## Features

- **Configurable timeouts**: Set different timeout values for readonly, default, and critical transactions
- **Environment-based configuration**: Configure timeouts via environment variables
- **Policy-based usage**: Use predefined policies (READONLY, DEFAULT, CRITICAL) for common scenarios
- **Custom timeout override**: Specify custom timeouts for specific operations
- **Automatic retry**: Optional exponential backoff retry on lock timeout
- **Type safety**: Full TypeScript support with proper error handling

## Configuration

### Environment Variables

```bash
# Lock timeout configuration (minimum 100ms)
DB_LOCK_TIMEOUT_READONLY_MS=1000    # Default: 1000ms (1s)
DB_LOCK_TIMEOUT_DEFAULT_MS=2000     # Default: 2000ms (2s)  
DB_LOCK_TIMEOUT_CRITICAL_MS=5000    # Default: 5000ms (5s)
```

### Configuration Interface

```typescript
interface Config {
  db: {
    url: string
    lockTimeouts: {
      readonlyMs: number
      defaultMs: number
      criticalMs: number
    }
  }
}
```

## Usage

### Basic Usage with Policies

```typescript
import { TransactionManager, LockTimeoutPolicy } from './db/transaction.js'

const txManager = new TransactionManager(pool, config.db.lockTimeouts)

// Readonly transaction (1s default timeout)
await txManager.withTransaction(
  async (client) => {
    const result = await client.query('SELECT * FROM users WHERE id = $1', [userId])
    return result.rows[0]
  },
  { policy: LockTimeoutPolicy.READONLY }
)

// Default transaction (2s default timeout)
await txManager.withTransaction(
  async (client) => {
    await client.query('INSERT INTO audit_log (action) VALUES ($1)', ['user_login'])
  },
  { policy: LockTimeoutPolicy.DEFAULT }
)

// Critical transaction with retry (5s default timeout)
await txManager.withTransaction(
  async (client) => {
    // Critical bond debit operation
    const lockResult = await client.query(
      'SELECT * FROM bonds WHERE id = $1 FOR UPDATE',
      [bondId]
    )
    // ... perform atomic debit operation
  },
  {
    policy: LockTimeoutPolicy.CRITICAL,
    isolationLevel: 'REPEATABLE READ',
    retryOnLockTimeout: true,
    maxRetries: 2,
    retryDelayMs: 100,
  }
)
```

### Custom Timeout Override

```typescript
// Custom 3-second timeout
await txManager.withTransaction(
  async (client) => {
    await client.query('UPDATE counters SET value = value + 1 WHERE id = $1', [counterId])
  },
  { timeoutMs: 3000 }
)
```

### Integration with Repositories

```typescript
// BondsRepository automatically uses configured timeouts
const bondsRepo = new BondsRepository(db, pool, config.db.lockTimeouts)

// Critical debit operation uses CRITICAL policy with retry
const updatedBond = await bondsRepo.debit(bondId, amount)
```

## Lock Timeout Policies

### READONLY (1s default)
- **Use case**: Read-only operations that may acquire shared locks
- **Examples**: User profile lookups, reporting queries, data validation
- **Behavior**: Short timeout to avoid blocking read operations

### DEFAULT (2s default)
- **Use case**: Standard write operations and business logic
- **Examples**: Creating records, updating non-critical fields, audit logging
- **Behavior**: Balanced timeout for general operations

### CRITICAL (5s default)
- **Use case**: Financial operations and critical state changes
- **Examples**: Bond debits, balance transfers, settlement processing
- **Behavior**: Longer timeout with retry for high-value operations

## Error Handling

### LockTimeoutError

```typescript
try {
  await txManager.withTransaction(operation, { policy: LockTimeoutPolicy.CRITICAL })
} catch (error) {
  if (error instanceof LockTimeoutError) {
    console.log(`Lock timeout after ${error.timeoutMs}ms with policy ${error.policy}`)
    // Implement retry logic or user notification
  }
}
```

### HTTP Error Response

The system automatically converts `LockTimeoutError` to appropriate HTTP responses:

```json
{
  "code": "LOCK_TIMEOUT",
  "message": "Resource is currently locked by another operation",
  "details": {
    "policy": "CRITICAL",
    "timeoutMs": 5000
  },
  "retryable": true,
  "retryAfterMs": 1000
}
```

## Retry Strategy

When `retryOnLockTimeout` is enabled, the system uses exponential backoff:

- **Base delay**: `retryDelayMs` (default: 100ms)
- **Backoff multiplier**: 2x per attempt
- **Maximum attempts**: `maxRetries` (default: 3)

Example retry timeline with 100ms base delay:
- Attempt 1: 0ms delay
- Attempt 2: 100ms delay  
- Attempt 3: 200ms delay
- Attempt 4: 400ms delay

## Implementation Details

### PostgreSQL Integration

The system sets PostgreSQL's `lock_timeout` parameter at the transaction level:

```sql
SET lock_timeout = '2s';  -- 2 second timeout
BEGIN;
SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
-- Transaction operations
COMMIT;
```

### Timeout Detection

Lock timeouts are detected using PostgreSQL error code `55P03`:

```typescript
private isLockTimeoutError(error: Error): boolean {
  return 'code' in error && error.code === PG_LOCK_TIMEOUT_CODE
}
```

## Testing

### Unit Tests

```bash
npm test -- src/db/transaction.test.ts
npm test -- src/__tests__/lock-timeout-config.test.ts
```

### Integration Tests

```bash
npm test -- src/__tests__/integration-example.test.ts
```

### Test Coverage

The test suite covers:
- Configuration validation and defaults
- Policy-based timeout application
- Custom timeout overrides
- Lock timeout error handling
- Retry logic with exponential backoff
- Isolation level setting
- Transaction commit/rollback behavior

## Migration Guide

### Existing Code

No changes required for existing code. The system provides safe defaults.

### New Code

Use the `TransactionManager` for new critical operations:

```typescript
// Before (manual transaction management)
const client = await pool.connect()
try {
  await client.query('BEGIN')
  // ... operations
  await client.query('COMMIT')
} catch (error) {
  await client.query('ROLLBACK')
  throw error
} finally {
  client.release()
}

// After (with configurable lock timeout)
await txManager.withTransaction(
  async (client) => {
    // ... operations
  },
  { policy: LockTimeoutPolicy.CRITICAL, retryOnLockTimeout: true }
)
```

## Production Considerations

### Monitoring

Monitor lock timeout frequency in production:
- High timeout rates may indicate contention issues
- Consider adjusting timeouts based on observed patterns
- Use application metrics to track retry attempts

### Performance Tuning

- **READONLY**: Keep low (500ms-1s) for responsive user experience
- **DEFAULT**: Moderate (1s-3s) for balanced operation
- **CRITICAL**: Higher (3s-10s) for important financial operations

### Database Configuration

Ensure PostgreSQL is configured appropriately:
```sql
-- Check current lock timeout
SHOW lock_timeout;

-- Monitor lock waits
SELECT * FROM pg_locks WHERE NOT granted;
```

## Security Considerations

- Lock timeouts prevent denial-of-service via long-held locks
- Retry logic prevents accidental data loss due to timeouts
- Error messages don't expose sensitive database internals
- All operations maintain ACID compliance
