import { resolveSiteId } from './logger.ts';

const LATENCY_BUCKETS_MS = [5, 15, 50, 150, 500, 1500];

function escapeLabelValue(val: string): string {
  return val.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function formatLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';
  return `{${entries.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(',')}}`;
}

export interface LivePlatformGauges {
  dbConnected: boolean;
  activeConnectionsCount: number;
  featureRowsStored: number;
  plantOeeAvailabilityPct: number;
  plantFaultWindows: number;
}

export class PlatformMetricsRegistry {
  private readonly startedAtMs = Date.now();
  private httpRequests = new Map<string, { method: string; route: string; statusClass: string; count: number }>();
  private latencyBucketCounts = new Map<number, number>(LATENCY_BUCKETS_MS.map((b) => [b, 0]));
  private latencyInfCount = 0;
  private latencySumMs = 0;
  private eventsIngestedTotal = 0;
  private eventsQuarantinedTotal = 0;
  private alertsDispatched = new Map<string, { channel: string; status: string; count: number }>();

  recordHttpRequest(method: string, route: string, statusCode: number, durationMs: number): void {
    const statusClass = `${Math.floor(statusCode / 100)}xx`;
    const key = `${method}|${route}|${statusClass}`;
    const existing = this.httpRequests.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      // Bound cardinality defensively
      const boundedRoute = this.httpRequests.size < 250 ? route : '/other';
      const boundedKey = `${method}|${boundedRoute}|${statusClass}`;
      const existingBounded = this.httpRequests.get(boundedKey);
      if (existingBounded) {
        existingBounded.count += 1;
      } else {
        this.httpRequests.set(boundedKey, {
          method,
          route: boundedRoute,
          statusClass,
          count: 1,
        });
      }
    }

    this.latencySumMs += Math.max(0, durationMs);
    this.latencyInfCount += 1;
    for (const bucket of LATENCY_BUCKETS_MS) {
      if (durationMs <= bucket) {
        this.latencyBucketCounts.set(bucket, (this.latencyBucketCounts.get(bucket) ?? 0) + 1);
      }
    }
  }

  recordIngestionBatch(accepted: number, quarantined: number): void {
    if (accepted > 0) this.eventsIngestedTotal += accepted;
    if (quarantined > 0) this.eventsQuarantinedTotal += quarantined;
  }

  recordAlertDelivery(channel: string, status: string): void {
    const key = `${channel}|${status}`;
    const existing = this.alertsDispatched.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      this.alertsDispatched.set(key, { channel, status, count: 1 });
    }
  }

  renderPrometheusText(gauges: LivePlatformGauges): string {
    const siteId = resolveSiteId();
    const mem = process.memoryUsage();
    const uptimeSec = Number(((Date.now() - this.startedAtMs) / 1000).toFixed(2));
    const lines: string[] = [];

    lines.push('# HELP telemetry_process_uptime_seconds Platform process uptime in seconds');
    lines.push('# TYPE telemetry_process_uptime_seconds gauge');
    lines.push(`telemetry_process_uptime_seconds${formatLabels({ site_id: siteId })} ${uptimeSec}`);

    lines.push('# HELP telemetry_process_memory_rss_bytes Resident set memory in bytes');
    lines.push('# TYPE telemetry_process_memory_rss_bytes gauge');
    lines.push(`telemetry_process_memory_rss_bytes${formatLabels({ site_id: siteId })} ${mem.rss}`);

    lines.push('# HELP telemetry_process_heap_used_bytes V8 heap used in bytes');
    lines.push('# TYPE telemetry_process_heap_used_bytes gauge');
    lines.push(`telemetry_process_heap_used_bytes${formatLabels({ site_id: siteId })} ${mem.heapUsed}`);

    lines.push('# HELP telemetry_db_connected PostgreSQL connection status (1=connected, 0=file-fallback)');
    lines.push('# TYPE telemetry_db_connected gauge');
    lines.push(`telemetry_db_connected${formatLabels({ site_id: siteId })} ${gauges.dbConnected ? 1 : 0}`);

    lines.push('# HELP telemetry_active_connections_total Configured OT/PLC connections');
    lines.push('# TYPE telemetry_active_connections_total gauge');
    lines.push(
      `telemetry_active_connections_total${formatLabels({ site_id: siteId })} ${gauges.activeConnectionsCount}`
    );

    lines.push('# HELP telemetry_feature_rows_stored Current ML feature windows stored');
    lines.push('# TYPE telemetry_feature_rows_stored gauge');
    lines.push(
      `telemetry_feature_rows_stored${formatLabels({ site_id: siteId })} ${gauges.featureRowsStored}`
    );

    lines.push('# HELP telemetry_plant_oee_availability_pct Latest aggregate plant OEE availability percentage');
    lines.push('# TYPE telemetry_plant_oee_availability_pct gauge');
    lines.push(
      `telemetry_plant_oee_availability_pct${formatLabels({ site_id: siteId })} ${gauges.plantOeeAvailabilityPct}`
    );

    lines.push('# HELP telemetry_plant_fault_windows_total Latest anomalous/fault feature windows observed');
    lines.push('# TYPE telemetry_plant_fault_windows_total gauge');
    lines.push(
      `telemetry_plant_fault_windows_total${formatLabels({ site_id: siteId })} ${gauges.plantFaultWindows}`
    );

    lines.push('# HELP telemetry_events_ingested_total Total valid telemetry events ingested via API');
    lines.push('# TYPE telemetry_events_ingested_total counter');
    lines.push(
      `telemetry_events_ingested_total${formatLabels({ site_id: siteId })} ${this.eventsIngestedTotal}`
    );

    lines.push('# HELP telemetry_events_quarantined_total Total malformed telemetry events quarantined');
    lines.push('# TYPE telemetry_events_quarantined_total counter');
    lines.push(
      `telemetry_events_quarantined_total${formatLabels({ site_id: siteId })} ${this.eventsQuarantinedTotal}`
    );

    lines.push('# HELP telemetry_alerts_dispatched_total Total alert deliveries attempted by channel and status');
    lines.push('# TYPE telemetry_alerts_dispatched_total counter');
    if (this.alertsDispatched.size === 0) {
      lines.push(
        `telemetry_alerts_dispatched_total${formatLabels({ site_id: siteId, channel: 'email', status: 'sent' })} 0`
      );
      lines.push(
        `telemetry_alerts_dispatched_total${formatLabels({ site_id: siteId, channel: 'webhook', status: 'sent' })} 0`
      );
    } else {
      for (const item of this.alertsDispatched.values()) {
        lines.push(
          `telemetry_alerts_dispatched_total${formatLabels({
            site_id: siteId,
            channel: item.channel,
            status: item.status,
          })} ${item.count}`
        );
      }
    }

    lines.push('# HELP telemetry_http_requests_total Total HTTP requests handled by method, route, and status class');
    lines.push('# TYPE telemetry_http_requests_total counter');
    for (const item of this.httpRequests.values()) {
      lines.push(
        `telemetry_http_requests_total${formatLabels({
          site_id: siteId,
          method: item.method,
          route: item.route,
          status_class: item.statusClass,
        })} ${item.count}`
      );
    }

    lines.push('# HELP telemetry_http_request_duration_ms HTTP request latency histogram in milliseconds');
    lines.push('# TYPE telemetry_http_request_duration_ms histogram');
    for (const bucket of LATENCY_BUCKETS_MS) {
      lines.push(
        `telemetry_http_request_duration_ms_bucket${formatLabels({
          site_id: siteId,
          le: String(bucket),
        })} ${this.latencyBucketCounts.get(bucket) ?? 0}`
      );
    }
    lines.push(
      `telemetry_http_request_duration_ms_bucket${formatLabels({
        site_id: siteId,
        le: '+Inf',
      })} ${this.latencyInfCount}`
    );
    lines.push(
      `telemetry_http_request_duration_ms_sum${formatLabels({ site_id: siteId })} ${Number(
        this.latencySumMs.toFixed(2)
      )}`
    );
    lines.push(
      `telemetry_http_request_duration_ms_count${formatLabels({ site_id: siteId })} ${this.latencyInfCount}`
    );

    return `${lines.join('\n')}\n`;
  }
}

export const metricsRegistry = new PlatformMetricsRegistry();
