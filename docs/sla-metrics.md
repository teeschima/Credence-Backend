# SLA Metrics - Percentile Latency

## Overview

Percentile latency metrics (p50, p95, p99) for HTTP requests with safe route template normalization to prevent cardinality explosion.

## Metrics

### `http_request_duration_percentiles_seconds`

**Type:** Summary  
**Labels:** `method`, `route`, `status`  
**Percentiles:** p50, p95, p99  
**Description:** HTTP request latency distribution

**Example output:**
```
# HELP http_request_duration_percentiles_seconds HTTP request latency percentiles (p50, p95, p99)
# TYPE http_request_duration_percentiles_seconds summary
http_request_duration_percentiles_seconds{method="GET",route="/api/trust/:address",status="200",quantile="0.5"} 0.025
http_request_duration_percentiles_seconds{method="GET",route="/api/trust/:address",status="200",quantile="0.95"} 0.15
http_request_duration_percentiles_seconds{method="GET",route="/api/trust/:address",status="200",quantile="0.99"} 0.35
http_request_duration_percentiles_seconds_sum{method="GET",route="/api/trust/:address",status="200"} 12.5
http_request_duration_percentiles_seconds_count{method="GET",route="/api/trust/:address",status="200"} 1000
```

## Cardinality Policy

### Route Template Normalization

Dynamic route segments are normalized to prevent cardinality explosion:

| Original Path | Normalized Template |
|--------------|---------------------|
| `/api/trust/0x123abc` | `/api/trust/:address` |
| `/api/bond/stellar123` | `/api/bond/:address` |
| `/api/jobs/550e8400-e29b-41d4-a716-446655440000` | `/api/jobs/:id` |
| `/api/users/12345` | `/api/users/:id` |
| `/api/attestations/0xabc/verify/123` | `/api/attestations/:address/verify/:id` |

### Cardinality Bounds

**Formula:** `methods × routes × status_codes`

- **Methods:** ~10 (GET, POST, PUT, DELETE, PATCH, etc.)
- **Routes:** ~50 (bounded by API surface area)
- **Status codes:** ~10 (200, 201, 400, 401, 403, 404, 500, 502, 503, 504)

**Total series:** ~5,000 time series (well within Prometheus limits)

### Implementation

1. **Primary strategy:** Use `req.route.path` from Express (already templated)
2. **Fallback strategy:** Pattern-based normalization for unmatched routes:
   - Hex addresses: `/0x[a-fA-F0-9]+/` → `/:address`
   - UUIDs: `/[uuid-pattern]/` → `/:id`
   - Numeric IDs: `/\d+/` → `/:id`

### Safety Guarantees

- **Bounded cardinality:** Max ~50 unique route templates
- **No user input in labels:** All dynamic segments normalized
- **Automatic cleanup:** Summary metrics expire after 10 minutes (5 age buckets × 2 minutes)

## Usage

### Middleware Integration

```typescript
import { latencyMetricsMiddleware } from './middleware/latencyMetrics.js'

app.use(latencyMetricsMiddleware)
```

### Querying Metrics

**p95 latency by route:**
```promql
http_request_duration_percentiles_seconds{quantile="0.95"}
```

**p99 latency for specific endpoint:**
```promql
http_request_duration_percentiles_seconds{route="/api/trust/:address",quantile="0.99"}
```

**Average latency (from sum/count):**
```promql
rate(http_request_duration_percentiles_seconds_sum[5m]) 
/ 
rate(http_request_duration_percentiles_seconds_count[5m])
```

**SLA compliance (% of requests under 200ms):**
```promql
sum(rate(http_request_duration_percentiles_seconds_bucket{le="0.2"}[5m])) 
/ 
sum(rate(http_request_duration_percentiles_seconds_count[5m]))
```

## Grafana Dashboard

Add panels for:

1. **p50/p95/p99 latency by route** (line graph)
2. **Latency heatmap** (heatmap visualization)
3. **SLA compliance gauge** (% under threshold)
4. **Slowest endpoints table** (sorted by p99)

Example query for panel 1:
```promql
http_request_duration_percentiles_seconds{quantile="0.95"}
```

## Testing

Run tests:
```bash
npm test src/__tests__/latencyMetrics.test.ts
npm test src/__tests__/latencyMetricsMiddleware.test.ts
```

Coverage includes:
- Route normalization correctness
- Cardinality bounds verification
- Middleware integration with Express
- Multiple HTTP methods and status codes
- Percentile calculation accuracy

## Monitoring

### Alerts

**High p99 latency:**
```yaml
- alert: HighP99Latency
  expr: http_request_duration_percentiles_seconds{quantile="0.99"} > 1.0
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: "High p99 latency on {{ $labels.route }}"
```

**SLA breach:**
```yaml
- alert: SLABreach
  expr: |
    (
      sum(rate(http_request_duration_percentiles_seconds_bucket{le="0.2"}[5m])) 
      / 
      sum(rate(http_request_duration_percentiles_seconds_count[5m]))
    ) < 0.95
  for: 10m
  labels:
    severity: critical
  annotations:
    summary: "SLA breach: <95% of requests under 200ms"
```

## Performance Impact

- **CPU overhead:** <1% (high-resolution timer + label lookup)
- **Memory overhead:** ~100KB per 1000 unique label combinations
- **Prometheus scrape size:** ~5KB per scrape (5000 series × 1 byte avg)

## References

- [Prometheus Summary Metric](https://prometheus.io/docs/practices/histograms/)
- [Cardinality Best Practices](https://prometheus.io/docs/practices/naming/#labels)
- [Express Route Matching](https://expressjs.com/en/guide/routing.html)
