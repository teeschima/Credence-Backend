import { describe, expect, it } from 'vitest'
import { 
  evaluateDueDateActions, 
  normalizeToUtcIso, 
  validateTimezone,
  isDstTransitionPeriod
} from './invoiceDueDate.js'

describe('invoiceDueDate utility', () => {
  it('normalizes valid timestamps to UTC ISO', () => {
    expect(normalizeToUtcIso('2026-03-24T12:00:00+02:00')).toBe('2026-03-24T10:00:00.000Z')
  })

  it('rejects ambiguous timestamps without timezone information', () => {
    expect(() => normalizeToUtcIso('2026-03-24T12:00:00')).toThrow(
      'Timestamp must include UTC offset or Z suffix',
    )
  })

  it('evaluates due-date boundaries in tenant timezone (cross-timezone safety)', () => {
    const invoices = [
      {
        invoiceId: 'inv-kiritimati-next-day',
        dueAtUtc: '2026-03-24T12:30:00.000Z',
      },
    ]

    const due = evaluateDueDateActions({
      invoices,
      tenantTimezone: 'Pacific/Kiritimati',
      nowUtc: '2026-03-24T01:00:00.000Z',
    })

    // In Pacific/Kiritimati (UTC+14), dueAt local day is 2026-03-25 while now local day is 2026-03-24.
    expect(due).toHaveLength(0)
  })

  it('handles DST forward transition using tenant-local day boundaries', () => {
    const invoices = [
      {
        invoiceId: 'inv-dst-spring-forward',
        dueAtUtc: '2026-03-08T05:30:00.000Z',
      },
    ]

    const beforeLocalMidnightBoundary = evaluateDueDateActions({
      invoices,
      tenantTimezone: 'America/New_York',
      nowUtc: '2026-03-08T03:30:00.000Z',
    })

    const afterLocalMidnightBoundary = evaluateDueDateActions({
      invoices,
      tenantTimezone: 'America/New_York',
      nowUtc: '2026-03-08T07:30:00.000Z',
    })

    expect(beforeLocalMidnightBoundary).toHaveLength(0)
    expect(afterLocalMidnightBoundary.map((item) => item.invoiceId)).toEqual([
      'inv-dst-spring-forward',
    ])
  })

  it('skips invoices already triggered', () => {
    const due = evaluateDueDateActions({
      tenantTimezone: 'UTC',
      nowUtc: '2026-03-24T12:00:00.000Z',
      invoices: [
        {
          invoiceId: 'already-triggered',
          dueAtUtc: '2026-03-23T00:00:00.000Z',
          actionTriggeredAtUtc: '2026-03-23T01:00:00.000Z',
        },
      ],
    })

    expect(due).toEqual([])
  })

  it('validates timezone strings', () => {
    expect(() => validateTimezone('UTC')).not.toThrow()
    expect(() => validateTimezone('America/New_York')).not.toThrow()
    expect(() => validateTimezone('Europe/London')).not.toThrow()
    expect(() => validateTimezone('Asia/Tokyo')).not.toThrow()
    
    expect(() => validateTimezone('Invalid/Timezone')).toThrow('Invalid IANA timezone: Invalid/Timezone')
    expect(() => validateTimezone('')).toThrow('Invalid IANA timezone: ')
    expect(() => validateTimezone('GMT+5')).toThrow('Invalid IANA timezone: GMT+5')
  })

  it('detects DST transition periods', () => {
    // US DST spring forward: 2026-03-08 at 2am local time
    const beforeSpringForward = new Date('2026-03-08T06:59:00.000Z') // 1:59am EST
    const afterSpringForward = new Date('2026-03-08T08:01:00.000Z')  // 3:01am EDT
    
    expect(isDstTransitionPeriod(beforeSpringForward, 'America/New_York')).toBe(true)
    expect(isDstTransitionPeriod(afterSpringForward, 'America/New_York')).toBe(true)
    
    // Regular day should not be transition
    const regularDay = new Date('2026-03-15T12:00:00.000Z')
    expect(isDstTransitionPeriod(regularDay, 'America/New_York')).toBe(false)
    
    // UTC never has DST transitions
    expect(isDstTransitionPeriod(regularDay, 'UTC')).toBe(false)
  })

  it('handles DST fall backward transition correctly', () => {
    // US DST fall back: 2026-11-01 at 2am local time
    const invoices = [
      {
        invoiceId: 'inv-dst-fall-back',
        dueAtUtc: '2026-11-01T06:30:00.000Z', // 1:30am EDT (before transition)
      },
    ]

    // Before transition: 1:30am EDT, invoice should be due
    const beforeTransition = evaluateDueDateActions({
      invoices,
      tenantTimezone: 'America/New_York',
      nowUtc: '2026-11-01T05:30:00.000Z', // 12:30am EDT
    })

    // After transition: 1:30am EST, invoice should still be due
    const afterTransition = evaluateDueDateActions({
      invoices,
      tenantTimezone: 'America/New_York',
      nowUtc: '2026-11-01T06:30:00.000Z', // 1:30am EST (after transition)
    })

    expect(beforeTransition).toHaveLength(1)
    expect(afterTransition).toHaveLength(1)
  })

  it('handles southern hemisphere DST transitions', () => {
    // Australia DST: starts in October, ends in April
    const invoices = [
      {
        invoiceId: 'inv-australia-dst',
        dueAtUtc: '2026-10-02T00:30:00.000Z',
      },
    ]

    // Before DST start
    const beforeDst = evaluateDueDateActions({
      invoices,
      tenantTimezone: 'Australia/Sydney',
      nowUtc: '2026-10-01T23:30:00.000Z',
    })

    // After DST start (clocks forward 1 hour)
    const afterDst = evaluateDueDateActions({
      invoices,
      tenantTimezone: 'Australia/Sydney',
      nowUtc: '2026-10-02T00:30:00.000Z',
    })

    expect(beforeDst).toHaveLength(0)
    expect(afterDst).toHaveLength(1)
  })

  it('handles European DST transitions correctly', () => {
    // EU DST: 2026-03-29 at 1am UTC
    const invoices = [
      {
        invoiceId: 'inv-eu-dst',
        dueAtUtc: '2026-03-29T00:30:00.000Z',
      },
    ]

    const beforeTransition = evaluateDueDateActions({
      invoices,
      tenantTimezone: 'Europe/London',
      nowUtc: '2026-03-28T23:30:00.000Z', // 11:30pm GMT
    })

    const afterTransition = evaluateDueDateActions({
      invoices,
      tenantTimezone: 'Europe/London',
      nowUtc: '2026-03-29T01:30:00.000Z', // 2:30am BST
    })

    expect(beforeTransition).toHaveLength(0)
    expect(afterTransition).toHaveLength(1)
  })

  it('handles timezone edge cases near international date line', () => {
    const invoices = [
      {
        invoiceId: 'inv-date-line-east',
        dueAtUtc: '2026-03-24T23:30:00.000Z',
      },
      {
        invoiceId: 'inv-date-line-west',
        dueAtUtc: '2026-03-24T00:30:00.000Z',
      },
    ]

    // Kiritimati (UTC+14) - first place to experience new day
    const kiritimatiResult = evaluateDueDateActions({
      invoices,
      tenantTimezone: 'Pacific/Kiritimati',
      nowUtc: '2026-03-24T10:00:00.000Z',
    })

    // Baker Island (UTC-12) - last place to experience new day
    const bakerIslandResult = evaluateDueDateActions({
      invoices,
      tenantTimezone: 'Etc/GMT+12', // Baker Island timezone
      nowUtc: '2026-03-24T10:00:00.000Z',
    })

    // Kiritimati should see both invoices as due (local date is 2026-03-25)
    expect(kiritimatiResult).toHaveLength(2)
    
    // Baker Island should only see the later invoice as due (local date is 2026-03-24)
    expect(bakerIslandResult).toHaveLength(1)
    expect(bakerIslandResult[0].invoiceId).toBe('inv-date-line-east')
  })

  it('canonicalizes all timestamp formats consistently', () => {
    // Test various input formats all produce canonical UTC ISO strings
    expect(normalizeToUtcIso('2026-03-24T12:00:00+02:00')).toBe('2026-03-24T10:00:00.000Z')
    expect(normalizeToUtcIso('2026-03-24T12:00:00-05:00')).toBe('2026-03-24T17:00:00.000Z')
    expect(normalizeToUtcIso('2026-03-24T12:00:00Z')).toBe('2026-03-24T12:00:00.000Z')
    expect(normalizeToUtcIso(new Date('2026-03-24T12:00:00Z'))).toBe('2026-03-24T12:00:00.000Z')
    expect(normalizeToUtcIso(new Date('2026-03-24T10:00:00+02:00'))).toBe('2026-03-24T08:00:00.000Z')
  })
})
