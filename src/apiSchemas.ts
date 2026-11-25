import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  extendZodWithOpenApi,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { APP_VERSION } from './config/appMeta.ts';
import { normalizeLanguage, type SupportedLanguage } from './i18n/types.ts';

extendZodWithOpenApi(z);

export interface OpenApiLocaleBundle {
  pageTitle: string;
  header: {
    brand: string;
    subtitle: string;
    backToConsole: string;
    languageLabel: string;
  };
  info: {
    title: string;
    description: string[];
    serverCurrentHost: string;
    serverRelativeOrigin: string;
  };
  securitySchemes: {
    GatewayBearerAuth: string;
    ApiKeyHeaderAuth: string;
    GatewayHeaderAuth: string;
  };
  tags: Record<string, { name: string; description: string }>;
  operations: Record<string, string>;
}

const localeBundleCache = new Map<SupportedLanguage, OpenApiLocaleBundle>();

export function getOpenApiLocale(lang?: string | null): OpenApiLocaleBundle {
  const normalized = normalizeLanguage(lang);
  const cached = localeBundleCache.get(normalized);
  if (cached) return cached;

  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidatePaths = [
    path.join(currentDir, 'i18n', 'locales', normalized, 'openapi.json'),
    path.join(process.cwd(), 'src', 'i18n', 'locales', normalized, 'openapi.json'),
  ];
  const localePath = candidatePaths.find((p) => fs.existsSync(p)) ?? candidatePaths[0];
  const parsed = JSON.parse(fs.readFileSync(localePath, 'utf-8')) as OpenApiLocaleBundle;
  localeBundleCache.set(normalized, parsed);
  return parsed;
}

export type ValidationTier = 'permissive' | 'strict';

const PROTOCOLS = ['opcua', 'modbus-tcp', 'mqtt-sparkplug', 'http-rest-meter'] as const;
const TOPOLOGIES = ['on-premise-lan', 'site-to-site-vpn', 'edge-gateway-push'] as const;
const AUTH_MODES = ['anonymous', 'username-password', 'x509-cert', 'bearer-token'] as const;
const DOMAINS = ['manufacturing', 'gas-metering', 'power-generation'] as const;
const BA_FORMULAS = [
  'oee_cycle_count',
  'gas_nm3_integration',
  'energy_kwh_integration',
  'custom_throughput',
] as const;

const SLUG_ID_REGEX = /^[a-zA-Z0-9._-]+$/;

export const ValidationErrorIssueSchema = z
  .object({
    path: z.string(),
    code: z.string(),
    message: z.string(),
  })
  .openapi('ValidationErrorIssue');

export const ApiErrorSchema = z
  .object({
    error: z.string(),
    tier: z.enum(['permissive', 'strict']).optional(),
    requestId: z.string().optional(),
    issues: z.array(ValidationErrorIssueSchema).optional(),
  })
  .openapi('ApiError');

export const TagBindingStrictSchema = z
  .object({
    sourceTag: z.string().min(1).max(120),
    targetMetric: z.string().min(1).max(48),
    scaleFactor: z.number().positive(),
    unit: z.string().max(16),
  })
  .strict()
  .openapi('TagBinding');

export const TagBindingPermissiveSchema = z
  .object({
    sourceTag: z.string().min(1).max(120).optional().default('tag_0'),
    targetMetric: z.string().min(1).max(48).optional().default('temp_c'),
    scaleFactor: z.coerce.number().positive().optional().default(1),
    unit: z.string().max(16).optional().default(''),
  })
  .passthrough();

export const PlcConnectionEntitySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    machineId: z.string(),
    lineId: z.string(),
    machineType: z.string(),
    protocol: z.enum(PROTOCOLS),
    deploymentTopology: z.enum(TOPOLOGIES),
    host: z.string(),
    port: z.number().int(),
    endpointOrTopic: z.string(),
    pollIntervalSec: z.number().int(),
    authMode: z.enum(AUTH_MODES),
    username: z.string().optional(),
    enabled: z.boolean(),
    status: z.enum(['configured', 'connected', 'unreachable', 'disabled']),
    lastProbeAt: z.string().nullable(),
    lastLatencyMs: z.number().nullable(),
    lastError: z.string().nullable(),
    samplesIngested: z.number().int(),
    tagBindings: z.array(TagBindingStrictSchema),
  })
  .openapi('PlcConnection');

export const NetworkDeploymentSettingsSchema = z
  .object({
    topologyMode: z.enum(TOPOLOGIES),
    siteName: z.string(),
    plantVlanCidr: z.string(),
    ingestApiUrl: z.string(),
    requireGatewayToken: z.boolean(),
    spoolMaxMb: z.number().int(),
    tokenFingerprint: z.string().nullable(),
    tokenUpdatedAt: z.string().nullable(),
  })
  .openapi('NetworkDeploymentSettings');

export const ConnectionsStateResponseSchema = z
  .object({
    settings: NetworkDeploymentSettingsSchema,
    connections: z.array(PlcConnectionEntitySchema),
    updatedAt: z.string(),
  })
  .openapi('ConnectionsStateResponse');

export const ConnectionUpsertStrictSchema = z
  .object({
    id: z.string().min(1).max(64).optional(),
    name: z.string().min(2).max(80),
    machineId: z.string().min(1).max(32),
    lineId: z.string().min(1).max(32),
    machineType: z.string().min(2).max(48).regex(SLUG_ID_REGEX),
    protocol: z.enum(PROTOCOLS),
    deploymentTopology: z.enum(TOPOLOGIES),
    host: z
      .string()
      .min(1)
      .max(128)
      .regex(SLUG_ID_REGEX, 'Host must be a valid IPv4, hostname, or FQDN'),
    port: z.number().int().min(1).max(65535),
    endpointOrTopic: z.string().min(1).max(200),
    pollIntervalSec: z.union([
      z.literal(1),
      z.literal(2),
      z.literal(5),
      z.literal(10),
      z.literal(30),
    ]),
    authMode: z.enum(AUTH_MODES),
    username: z.string().max(64).optional(),
    enabled: z.boolean().optional(),
    tagBindings: z.array(TagBindingStrictSchema).min(1).max(16).optional(),
  })
  .strict()
  .openapi('ConnectionUpsertStrict');

export const ConnectionUpsertPermissiveSchema = z
  .object({
    id: z.string().min(1).max(64).optional(),
    name: z.string().max(80).optional(),
    machineId: z.string().min(1).max(32).optional(),
    machine_id: z.string().min(1).max(32).optional(),
    lineId: z.string().max(32).optional(),
    line_id: z.string().max(32).optional(),
    machineType: z.string().max(48).optional(),
    machine_type: z.string().max(48).optional(),
    protocol: z.enum(PROTOCOLS).optional(),
    deploymentTopology: z.enum(TOPOLOGIES).optional(),
    host: z.string().min(1).max(128).optional(),
    port: z.coerce.number().int().min(1).max(65535).optional(),
    endpointOrTopic: z.string().max(200).optional(),
    pollIntervalSec: z.coerce.number().optional(),
    authMode: z.enum(AUTH_MODES).optional(),
    username: z.string().max(64).optional(),
    enabled: z.boolean().optional(),
    tagBindings: z.array(TagBindingPermissiveSchema).max(16).optional(),
  })
  .passthrough()
  .openapi('ConnectionUpsertPermissive');

export const ConnectionUpsertResponseSchema = z
  .object({
    connection: PlcConnectionEntitySchema,
    state: ConnectionsStateResponseSchema,
  })
  .openapi('ConnectionUpsertResponse');

export const ConnectionDeleteResponseSchema = z
  .object({
    deleted: z.boolean(),
    state: ConnectionsStateResponseSchema,
  })
  .openapi('ConnectionDeleteResponse');

export const ConnectionProbeResultSchema = z
  .object({
    connectionId: z.string(),
    reachable: z.boolean(),
    protocol: z.enum(PROTOCOLS),
    host: z.string(),
    port: z.number().int(),
    latencyMs: z.number().nullable(),
    checkedAt: z.string(),
    errorCode: z.string().nullable(),
    errorMessage: z.string().nullable(),
  })
  .openapi('ConnectionProbeResult');

export const ConnectionProbeResponseSchema = z
  .object({
    probe: ConnectionProbeResultSchema,
    state: ConnectionsStateResponseSchema,
  })
  .openapi('ConnectionProbeResponse');

export const GatewayTokenRotateResponseSchema = z
  .object({
    token: z.string(),
    tokenFingerprint: z.string(),
    tokenUpdatedAt: z.string(),
    state: ConnectionsStateResponseSchema,
  })
  .openapi('GatewayTokenRotateResponse');

export const ScopedKeyRotateRequestSchema = z
  .object({
    scope: z.enum(['edge', 'read', 'admin']),
  })
  .strict()
  .openapi('ScopedKeyRotateRequest');

export const ScopedKeyRotateResponseSchema = z
  .object({
    scope: z.enum(['edge', 'read', 'admin']),
    token: z.string(),
    tokenFingerprint: z.string(),
    tokenUpdatedAt: z.string(),
    state: ConnectionsStateResponseSchema,
  })
  .openapi('ScopedKeyRotateResponse');

export const AuthWhoAmIResponseSchema = z
  .object({
    authenticated: z.boolean(),
    grantedScope: z.enum(['edge', 'read', 'admin', 'anonymous']),
    enforcementEnabled: z.boolean(),
    requestId: z.string(),
    allowedScopes: z.array(z.enum(['edge', 'read', 'admin'])),
    authSource: z.string().optional(),
    tokenId: z.string().optional(),
    tokenName: z.string().optional(),
    tokenPrefix: z.string().optional(),
    ownerEmail: z.string().optional(),
    role: z.enum(['admin', 'operator', 'viewer']).optional(),
  })
  .openapi('AuthWhoAmIResponse');

export const OnPremDeployBundleSchema = z
  .object({
    generatedAt: z.string(),
    topologyMode: z.enum(TOPOLOGIES),
    edgeConnectionsJson: z.string(),
    edgeEnvFile: z.string(),
    onPremComposeYml: z.string(),
    installScriptSh: z.string(),
  })
  .openapi('OnPremDeployBundle');

export const NetworkSettingsStrictSchema = z
  .object({
    topologyMode: z.enum(TOPOLOGIES),
    siteName: z.string().min(2).max(80),
    plantVlanCidr: z.string().min(4).max(64),
    ingestApiUrl: z.string().url().max(200),
    requireGatewayToken: z.boolean(),
    spoolMaxMb: z.union([z.literal(256), z.literal(1024), z.literal(4096)]),
  })
  .strict()
  .openapi('NetworkDeploymentSettingsInput');

export const NetworkSettingsPermissiveSchema = z
  .object({
    topologyMode: z.enum(TOPOLOGIES).optional(),
    siteName: z.string().max(80).optional(),
    plantVlanCidr: z.string().max(64).optional(),
    ingestApiUrl: z.string().max(200).optional(),
    requireGatewayToken: z.boolean().optional(),
    spoolMaxMb: z.coerce.number().optional(),
  })
  .passthrough();

export const PlcExtraChannelSchema = z
  .object({
    key: z.string().min(1).max(40),
    unit: z.string().min(1).max(16),
    nominal: z.number(),
    std: z.number().min(0),
  })
  .strict()
  .openapi('PlcExtraChannel');

export const PlcCatalogProfileSchema = z
  .object({
    typeId: z.string(),
    label: z.string(),
    vendorFamily: z.string(),
    domain: z.enum(DOMAINS),
    defaultProtocol: z.enum(PROTOCOLS),
    defaultPort: z.number().int(),
    isBuiltIn: z.boolean(),
    primaryKey: z.string(),
    primaryUnit: z.string(),
    primaryNominal: z.number(),
    primaryStd: z.number(),
    primaryFaultThreshold: z.number(),
    primaryFaultLowThreshold: z.number().optional(),
    secondaryKey: z.string(),
    secondaryUnit: z.string(),
    secondaryNominal: z.number(),
    secondaryStd: z.number(),
    secondaryFaultThreshold: z.number().optional(),
    tempNominalC: z.number(),
    tempStdC: z.number(),
    tempFaultThresholdC: z.number(),
    extraChannels: z.array(PlcExtraChannelSchema),
    defaultOutputFields: z.array(z.string()),
    baFormula: z.enum(BA_FORMULAS),
    updatedAt: z.string(),
  })
  .openapi('PlcCatalogProfile');

export const PlcCatalogUpsertStrictSchema = z
  .object({
    typeId: z.string().min(2).max(48).regex(SLUG_ID_REGEX),
    label: z.string().min(2).max(80),
    vendorFamily: z.string().min(2).max(80),
    domain: z.enum(DOMAINS),
    defaultProtocol: z.enum(PROTOCOLS),
    defaultPort: z.number().int().min(1).max(65535),
    primaryKey: z.string().min(1).max(40),
    primaryUnit: z.string().min(1).max(16),
    primaryNominal: z.number(),
    primaryStd: z.number().min(0),
    primaryFaultThreshold: z.number(),
    primaryFaultLowThreshold: z.number().optional(),
    secondaryKey: z.string().min(1).max(40),
    secondaryUnit: z.string().min(1).max(16),
    secondaryNominal: z.number(),
    secondaryStd: z.number().min(0),
    secondaryFaultThreshold: z.number().optional(),
    tempNominalC: z.number().min(-50).max(200),
    tempStdC: z.number().min(0),
    tempFaultThresholdC: z.number().min(-30).max(250),
    extraChannels: z.array(PlcExtraChannelSchema).max(8).optional(),
    defaultOutputFields: z.array(z.string()).min(1).max(20),
    baFormula: z.enum(BA_FORMULAS),
  })
  .strict()
  .openapi('PlcCatalogUpsertStrict');

export const PlcCatalogUpsertPermissiveSchema = z
  .object({
    typeId: z.string().min(2).max(48),
    label: z.string().max(80).optional(),
    vendorFamily: z.string().max(80).optional(),
    domain: z.enum(DOMAINS).optional(),
    defaultProtocol: z.enum(PROTOCOLS).optional(),
    defaultPort: z.coerce.number().int().min(1).max(65535).optional(),
    primaryKey: z.string().max(40).optional(),
    primaryUnit: z.string().max(16).optional(),
    primaryNominal: z.coerce.number().optional(),
    primaryStd: z.coerce.number().optional(),
    primaryFaultThreshold: z.coerce.number().optional(),
    secondaryKey: z.string().max(40).optional(),
    secondaryUnit: z.string().max(16).optional(),
    secondaryNominal: z.coerce.number().optional(),
    tempNominalC: z.coerce.number().optional(),
    tempFaultThresholdC: z.coerce.number().optional(),
    extraChannels: z.array(z.any()).max(8).optional(),
    defaultOutputFields: z.array(z.string()).optional(),
    baFormula: z.enum(BA_FORMULAS).optional(),
  })
  .passthrough()
  .openapi('PlcCatalogUpsertPermissive');

export const PlcCatalogListResponseSchema = z
  .object({
    profiles: z.array(PlcCatalogProfileSchema),
    availableOutputFields: z.array(z.string()),
    updatedAt: z.string(),
  })
  .openapi('PlcCatalogListResponse');

export const PlcCatalogUpsertResponseSchema = z
  .object({
    profile: PlcCatalogProfileSchema,
    catalog: PlcCatalogListResponseSchema,
    created: z.boolean(),
  })
  .openapi('PlcCatalogUpsertResponse');

export const PlcCatalogDeleteResponseSchema = z
  .object({
    deleted: z.boolean(),
    resetToBuiltIn: z.boolean(),
    catalog: PlcCatalogListResponseSchema,
  })
  .openapi('PlcCatalogDeleteResponse');

export const PlcOutputPreviewRequestSchema = z
  .object({
    machineId: z.string().min(1).max(32).optional(),
    lineId: z.string().min(1).max(32).optional(),
    state: z.enum(['IDLE', 'RUNNING', 'DEGRADED', 'FAULT', 'MAINTENANCE']).optional(),
    fields: z.array(z.string()).optional(),
  })
  .passthrough()
  .openapi('PlcOutputPreviewRequest');

export const PlcOutputPreviewResponseSchema = z
  .object({
    typeId: z.string(),
    profile: PlcCatalogProfileSchema,
    sampleEnvelope: z.record(z.string(), z.unknown()),
    projectedFeatureWindow: z.record(z.string(), z.unknown()),
    projectedBaKpi: z.record(z.string(), z.unknown()),
  })
  .openapi('PlcOutputPreviewResponse');

export const JobConfigSchema = z
  .object({
    environment: z.enum(['local', 'staging', 'production']),
    executionMode: z.enum(['continuous-watch', 'one-shot-batch']),
    watchIntervalSec: z.number().int(),
    windowMinutes: z.number().int(),
    watermarkLookbackMin: z.number().int(),
    horizonWindows: z.number().int(),
    rotateMaxLines: z.number().int(),
    dedupStrategy: z.enum(['event_id_strict', 'event_id_plus_timestamp']),
    malformedPolicy: z.enum(['quarantine_sha256', 'drop_and_count', 'halt_on_error']),
    timestampMode: z.enum(['utc_iso8601_strict', 'utc_coerced']),
    machineProfileMode: z.string(),
    machinesPerLine: z.number().int(),
    tempAnomalyThresholdC: z.number(),
    vibrationP95Threshold: z.number(),
    minValidSampleRatio: z.number(),
    datasetVersion: z.string(),
    storageTarget: z.enum(['garage-s3', 'rustfs-s3', 'local-fs']),
    parquetCompression: z.enum(['zstd', 'snappy', 'gzip']),
    partitionLayout: z.enum(['domain/dt', 'dt/machine_id', 'dt/line_id/machine_id', 'dt/hour/machine_id']),
    featureMartSink: z.enum(['postgres-upsert', 'parquet-only']),
    hotRetentionDays: z.number().int(),
    coldRetentionDays: z.number().int(),
    coldStorageEndpoint: z.enum(['garage-s3-cold', 's3-glacier-compatible', 'nas-cold-archive']),
    lakehouseFormat: z.enum(['duckdb-parquet-compacted', 'hive-parquet-append']),
    compactionSchedule: z.enum(['hourly', 'daily-01utc', 'weekly-sun']),
    ingestTransport: z.enum(['local-segments', 'http-batch-ingest']),
    customMachineTopology: z.string(),
    ignoredErrorCodes: z.string(),
  })
  .openapi('JobConfig');

export const JobConfigStrictSchema = z
  .object({
    environment: z.enum(['local', 'staging', 'production']).optional(),
    executionMode: z.enum(['continuous-watch', 'one-shot-batch']).optional(),
    watchIntervalSec: z.union([z.literal(10), z.literal(30), z.literal(60), z.literal(300)]).optional(),
    windowMinutes: z.union([z.literal(1), z.literal(5), z.literal(15)]).optional(),
    watermarkLookbackMin: z.union([z.literal(5), z.literal(15), z.literal(30), z.literal(60)]).optional(),
    horizonWindows: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
    rotateMaxLines: z
      .union([z.literal(250), z.literal(500), z.literal(1000), z.literal(2000), z.literal(5000)])
      .optional(),
    dedupStrategy: z.enum(['event_id_strict', 'event_id_plus_timestamp']).optional(),
    malformedPolicy: z.enum(['quarantine_sha256', 'drop_and_count', 'halt_on_error']).optional(),
    timestampMode: z.enum(['utc_iso8601_strict', 'utc_coerced']).optional(),
    machineProfileMode: z.string().min(2).max(48).optional(),
    machinesPerLine: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)]).optional(),
    tempAnomalyThresholdC: z.union([z.literal(75), z.literal(82), z.literal(90), z.literal(95)]).optional(),
    vibrationP95Threshold: z.union([z.literal(2.5), z.literal(3.5), z.literal(4.5), z.literal(6.0)]).optional(),
    minValidSampleRatio: z.union([z.literal(0.5), z.literal(0.75), z.literal(0.85), z.literal(0.95)]).optional(),
    datasetVersion: z.enum(['v1.0.0', 'v1.1.0', 'v2.0.0-rc1']).optional(),
    storageTarget: z.enum(['garage-s3', 'rustfs-s3', 'local-fs']).optional(),
    parquetCompression: z.enum(['zstd', 'snappy', 'gzip']).optional(),
    partitionLayout: z
      .enum(['domain/dt', 'dt/machine_id', 'dt/line_id/machine_id', 'dt/hour/machine_id'])
      .optional(),
    featureMartSink: z.enum(['postgres-upsert', 'parquet-only']).optional(),
    hotRetentionDays: z.union([z.literal(7), z.literal(30), z.literal(90), z.literal(180)]).optional(),
    coldRetentionDays: z.union([z.literal(180), z.literal(365), z.literal(1095), z.literal(1825)]).optional(),
    coldStorageEndpoint: z.enum(['garage-s3-cold', 's3-glacier-compatible', 'nas-cold-archive']).optional(),
    lakehouseFormat: z.enum(['duckdb-parquet-compacted', 'hive-parquet-append']).optional(),
    compactionSchedule: z.enum(['hourly', 'daily-01utc', 'weekly-sun']).optional(),
    ingestTransport: z.enum(['local-segments', 'http-batch-ingest']).optional(),
    customMachineTopology: z.string().max(2000).optional(),
    ignoredErrorCodes: z.string().max(1000).optional(),
  })
  .strict()
  .openapi('JobConfigInput');

export const JobConfigPermissiveSchema = z
  .object({
    environment: z.enum(['local', 'staging', 'production']).optional(),
    watchIntervalSec: z.coerce.number().optional(),
    windowMinutes: z.coerce.number().optional(),
    rotateMaxLines: z.coerce.number().optional(),
    vibrationP95Threshold: z.coerce.number().optional(),
    minValidSampleRatio: z.coerce.number().optional(),
  })
  .passthrough();

export const JobConfigResponseSchema = z
  .object({
    config: JobConfigSchema,
    updatedAt: z.string(),
  })
  .openapi('JobConfigResponse');

export const TelemetryEnvelopeStrictSchema = z
  .object({
    event_id: z.string().min(1).max(128).optional(),
    timestamp: z.string().datetime({ offset: true }),
    machine_id: z.string().min(1).max(64),
    line_id: z.string().min(1).max(64),
    machine_type: z.string().min(2).max(48).regex(SLUG_ID_REGEX),
    site_id: z.string().min(1).max(64).optional(),
    domain: z.enum(DOMAINS).optional(),
    state: z.enum(['IDLE', 'RUNNING', 'DEGRADED', 'FAULT', 'MAINTENANCE']),
    level: z.enum(['INFO', 'WARN', 'ERROR']).optional(),
    error_code: z.string().nullable().optional(),
    metrics: z
      .object({
        temp_c: z.number().min(-50).max(250),
      })
      .catchall(z.number()),
  })
  .strict()
  .openapi('TelemetryEnvelopeStrict');

export const IngestBatchStrictSchema = z
  .object({
    events: z.array(TelemetryEnvelopeStrictSchema).min(1).max(5000),
  })
  .strict()
  .openapi('IngestBatchStrict');

export const IngestBatchPermissiveSchema = z
  .object({
    events: z.array(z.unknown()).min(1).max(5000).optional(),
    event: z.unknown().optional(),
  })
  .refine((val) => (Array.isArray(val.events) && val.events.length > 0) || val.event !== undefined, {
    message: 'Provide a non-empty events array or a single event object.',
  })
  .openapi('IngestBatchPermissive');

export const IngestBatchResponseSchema = z
  .object({
    runId: z.string(),
    accepted: z.number().int(),
    deduplicated: z.number().int(),
    quarantined: z.number().int(),
  })
  .openapi('IngestBatchResponse');

export const ConnectionTestBatchResponseSchema = z
  .object({
    result: IngestBatchResponseSchema,
    envelope: z.record(z.string(), z.unknown()),
    state: ConnectionsStateResponseSchema,
  })
  .openapi('ConnectionTestBatchResponse');

export const PipelineRunCreateStrictSchema = z
  .object({
    durationMinutes: z.number().int().min(1).max(1440),
    eventsPerSec: z.number().int().min(1).max(50),
    speedMultiplier: z.union([z.literal(1), z.literal(10), z.literal(60), z.literal(300)]),
    machineCount: z.number().int().min(2).max(32),
    windowMinutes: z.union([z.literal(1), z.literal(5), z.literal(15)]).optional(),
    machinesPerLine: z.number().int().min(1).max(16).optional(),
    machineProfileMode: z.string().optional(),
    selectedPlcTypes: z.array(z.string()).max(32).optional(),
    outputFields: z.array(z.string()).max(30).optional(),
    faultProbabilityPct: z.number().min(0).max(30).optional(),
    malformedRatePct: z.number().min(0).max(25).optional(),
    outOfOrderRatePct: z.number().min(0).max(30).optional(),
    rotateMaxLines: z.number().int().min(100).max(10000).optional(),
    seed: z.number().int().optional(),
  })
  .passthrough()
  .openapi('PipelineRunCreate');

export const PipelineRunCreatePermissiveSchema = z
  .object({
    durationMinutes: z.coerce.number().optional(),
    eventsPerSec: z.coerce.number().optional(),
    speedMultiplier: z.coerce.number().optional(),
    machineCount: z.coerce.number().optional(),
    selectedPlcTypes: z.array(z.string()).optional(),
    outputFields: z.array(z.string()).optional(),
  })
  .passthrough();

export const LiveRunSnapshotSchema = z
  .object({
    runId: z.string(),
    status: z.enum(['running', 'paused', 'completed', 'stopped']),
    config: z.record(z.string(), z.unknown()),
    startedAt: z.string(),
    updatedAt: z.string(),
    elapsedWallSec: z.number(),
    elapsedSimSec: z.number(),
    targetSimSec: z.number(),
    progressPct: z.number(),
    totalCallsEmitted: z.number().int(),
    targetTotalCalls: z.number().int(),
    effectiveRatePerSec: z.number(),
    validEventsCount: z.number().int(),
    quarantinedCount: z.number().int(),
    outOfOrderCount: z.number().int(),
    rotatedSegmentsCount: z.number().int(),
    highWatermarkIso: z.string().nullable(),
    expectedSampleSec: z.number(),
    anomalousWindowsCount: z.number().int(),
    featureRowsCount: z.number().int(),
    tieringSummary: z.record(z.string(), z.unknown()),
    recentLogs: z.array(z.record(z.string(), z.unknown())),
    segments: z.array(z.record(z.string(), z.unknown())),
    quarantineRecords: z.array(z.record(z.string(), z.unknown())),
    features: z.array(z.record(z.string(), z.unknown())),
    partitionPaths: z.array(z.string()),
  })
  .openapi('LiveRunSnapshot');

export const LatestRunResponseSchema = z
  .object({
    run: LiveRunSnapshotSchema.nullable(),
  })
  .openapi('LatestRunResponse');

export const EdgeConfigResponseSchema = z
  .object({
    config_hash: z.string(),
    updated_at: z.string(),
    sync_interval_sec: z.number().int(),
    site_name: z.string(),
    deployment_topology: z.enum(TOPOLOGIES),
    ingest_api_url: z.string(),
    spool_max_mb: z.number().int(),
    connections: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        machine_id: z.string(),
        line_id: z.string(),
        machine_type: z.string(),
        domain: z.enum(DOMAINS).optional(),
        protocol: z.enum(PROTOCOLS),
        host: z.string(),
        port: z.number().int(),
        endpoint_or_topic: z.string(),
        poll_interval_sec: z.number().int(),
        auth_mode: z.enum(AUTH_MODES),
        tag_bindings: z.array(
          z.object({
            source_tag: z.string(),
            target_metric: z.string(),
            scale_factor: z.number(),
            unit: z.string(),
          })
        ),
      })
    ),
  })
  .openapi('EdgeSyncConfig');

export const VersionResponseSchema = z
  .object({
    name: z.string(),
    fullName: z.string(),
    slug: z.string(),
    version: z.string(),
    tag: z.string(),
    channel: z.string(),
    apiContract: z.string(),
    license: z.string(),
    environment: z.string(),
    plantSiteId: z.string(),
    buildSha: z.string().nullable(),
    buildTime: z.string().nullable(),
  })
  .openapi('VersionResponse');

export const HealthResponseSchema = z
  .object({
    status: z.literal('ok'),
    name: z.string().optional(),
    version: z.string().optional(),
    environment: z.string(),
    apiVersion: z.string(),
    activeRunId: z.string().nullable(),
    activeRunStatus: z.string().nullable(),
    storage: z
      .object({
        mode: z.enum(['postgres', 'file-fallback']),
        connected: z.boolean(),
        databaseHost: z.string().nullable(),
        featureRowsStored: z.number().int().nullable(),
        lastError: z.string().nullable(),
      })
      .optional(),
    updatedAt: z.string(),
  })
  .openapi('HealthResponse');

export const BaKpiRowSchema = z
  .object({
    dt: z.string(),
    domain: z.enum(DOMAINS),
    line_id: z.string(),
    machine_id: z.string(),
    machine_type: z.string(),
    observed_windows: z.number().int(),
    total_samples: z.number().int(),
    monitored_hours: z.number(),
    downtime_fault_hours: z.number(),
    availability_oee_pct: z.number(),
    anomalous_windows: z.number().int(),
    primary_metric_name: z.string(),
    primary_metric_unit: z.string(),
    primary_metric_avg: z.number(),
    estimated_energy_kwh: z.number(),
    estimated_gas_volume_nm3: z.number(),
  })
  .openapi('BusinessAnalyticsKpiRow');

export const BaKpiResponseSchema = z
  .object({
    generatedAt: z.string(),
    dataSource: z.enum(['postgres', 'live-snapshot']).optional(),
    datasetVersion: z.string(),
    filters: z.object({
      machineType: z.string().nullable(),
      domain: z.string().nullable(),
      fromDate: z.string().nullable().optional(),
      toDate: z.string().nullable().optional(),
      fields: z.array(z.string()).nullable(),
    }),
    rowCount: z.number().int(),
    rows: z.array(z.union([BaKpiRowSchema, z.record(z.string(), z.unknown())])),
  })
  .openapi('BaKpiResponse');

export function resolveValidationTier(
  headerVal: string | undefined,
  queryVal: unknown
): ValidationTier {
  const candidate = (typeof queryVal === 'string' ? queryVal : headerVal ?? '').trim().toLowerCase();
  return candidate === 'strict' ? 'strict' : 'permissive';
}

export function formatZodIssues(err: z.ZodError) {
  return err.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join('.') : '(root)',
    code: issue.code,
    message: issue.message,
  }));
}

export function projectRowFields<T extends Record<string, unknown>>(
  row: T,
  fields?: string[] | null
): Record<string, unknown> {
  if (!fields || fields.length === 0) return row;
  const out: Record<string, unknown> = {};
  for (const key of fields) {
    if (key in row) {
      out[key] = row[key];
    }
  }
  return Object.keys(out).length > 0 ? out : row;
}

export function generateOpenApiSpec(serverOrigin?: string, lang?: string | null) {
  const locale = getOpenApiLocale(lang);
  const registry = new OpenAPIRegistry();

  registry.registerComponent('securitySchemes', 'GatewayBearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'adm_live_... | bi_live_... | gw_live_...',
    description: locale.securitySchemes.GatewayBearerAuth,
  });

  registry.registerComponent('securitySchemes', 'ApiKeyHeaderAuth', {
    type: 'apiKey',
    in: 'header',
    name: 'X-API-Key',
    description: locale.securitySchemes.ApiKeyHeaderAuth,
  });

  registry.registerComponent('securitySchemes', 'GatewayHeaderAuth', {
    type: 'apiKey',
    in: 'header',
    name: 'X-Gateway-Token',
    description: locale.securitySchemes.GatewayHeaderAuth,
  });

  const allAuthSecurity: Array<Record<string, string[]>> = [
    { GatewayBearerAuth: [] },
    { ApiKeyHeaderAuth: [] },
    { GatewayHeaderAuth: [] },
  ];

  const validationModeHeader = z.object({
    'x-validation-mode': z
      .enum(['permissive', 'strict'])
      .optional()
      .openapi({
        description:
          'Selects Tier 1 (permissive, default) or Tier 2 (strict) Zod validation enforcement.',
        example: 'permissive',
      }),
  });

  // System & Diagnostics
  registry.registerPath({
    method: 'get',
    path: '/api/v1/version',
    tags: ['System & Diagnostics'],
    summary: 'Centralized platform release version, API contract & build metadata (also mounted at /version)',
    description: 'Returns the single-source-of-truth platform version from config/app.json alongside optional CI/Docker build SHA and timestamp metadata.',
    responses: {
      200: {
        description: 'Platform version & deployment metadata',
        content: { 'application/json': { schema: VersionResponseSchema } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/health',
    tags: ['System & Diagnostics'],
    summary: 'Service health & active run heartbeat',
    description: 'Public health endpoint used by Edge Collectors, Docker healthchecks, and load balancers.',
    responses: {
      200: {
        description: 'Service healthy',
        content: { 'application/json': { schema: HealthResponseSchema } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/healthz',
    tags: ['System & Diagnostics'],
    summary: 'Kubernetes / Docker liveness probe',
    responses: {
      200: { description: 'Process event loop alive', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/readyz',
    tags: ['System & Diagnostics'],
    summary: 'Kubernetes / Docker readiness probe (returns 503 during graceful shutdown)',
    responses: {
      200: { description: 'Ready to accept traffic', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
      503: { description: 'Shutting down', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/metrics',
    tags: ['System & Diagnostics'],
    summary: 'Prometheus OpenMetrics exposition endpoint (also mounted at /metrics)',
    description: 'Exposes HTTP throughput/latency histograms, telemetry ingestion & quarantine counters, alert delivery counts, DB status, and aggregate plant OEE gauges.',
    responses: {
      200: { description: 'Prometheus text exposition format (0.0.4)', content: { 'text/plain': { schema: z.string() } } },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/auth/whoami',
    tags: ['System & Diagnostics'],
    summary: 'Verify active Bearer / X-API-Key credential & granted scope',
    description:
      'Diagnostic endpoint designed for Scalar & client verification. Returns the active scope (`admin`, `read`, `edge`, or `anonymous`) and whether strict auth enforcement is active. Rejects invalid credentials with `401 Unauthorized`.',
    security: allAuthSecurity,
    responses: {
      200: {
        description: 'Credential valid (or anonymous access when enforcement is disabled)',
        content: { 'application/json': { schema: AuthWhoAmIResponseSchema } },
      },
      401: { description: 'Invalid credential', content: { 'application/json': { schema: ApiErrorSchema } } },
    },
  });

  // PLC Catalog & Output Parameterization
  registry.registerPath({
    method: 'get',
    path: '/api/v1/catalog/machines',
    tags: ['PLC Catalog & Output Contract'],
    summary: 'List all PLC & industrial meter catalog profiles (scope: read)',
    description:
      'Returns built-in (Siemens S7-1500, Rockwell ControlLogix, CNC, Gas Meter, Power Meter, Turbine) and custom registered PLC profiles, including their metric channels, thresholds, BA formulas, and parameterizable output fields.',
    security: allAuthSecurity,
    request: {
      query: z.object({
        domain: z.enum(DOMAINS).optional(),
        protocol: z.enum(PROTOCOLS).optional(),
      }),
    },
    responses: {
      200: {
        description: 'Catalog profiles list',
        content: { 'application/json': { schema: PlcCatalogListResponseSchema } },
      },
      401: { description: 'Unauthorized', content: { 'application/json': { schema: ApiErrorSchema } } },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/catalog/machines/{typeId}',
    tags: ['PLC Catalog & Output Contract'],
    summary: 'Retrieve a single PLC profile specification (scope: read)',
    security: allAuthSecurity,
    request: { params: z.object({ typeId: z.string() }) },
    responses: {
      200: {
        description: 'PLC catalog profile',
        content: { 'application/json': { schema: PlcCatalogProfileSchema } },
      },
      404: { description: 'PLC profile not found', content: { 'application/json': { schema: ApiErrorSchema } } },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/catalog/machines',
    tags: ['PLC Catalog & Output Contract'],
    summary: 'Register or parameterize a PLC profile in the catalog (scope: admin)',
    description:
      'Creates or updates a PLC / meter specification and its output field contract. Persisted atomically in `.state/plc-catalog.json` and immediately available in Live Simulation, Plant Connections, Edge Auto-Sync, and BA KPI endpoints.',
    security: allAuthSecurity,
    request: {
      headers: validationModeHeader,
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z.union([PlcCatalogUpsertStrictSchema, PlcCatalogUpsertPermissiveSchema]),
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Existing PLC profile updated',
        content: { 'application/json': { schema: PlcCatalogUpsertResponseSchema } },
      },
      201: {
        description: 'New PLC profile registered',
        content: { 'application/json': { schema: PlcCatalogUpsertResponseSchema } },
      },
      400: { description: 'Validation error', content: { 'application/json': { schema: ApiErrorSchema } } },
      401: { description: 'Unauthorized', content: { 'application/json': { schema: ApiErrorSchema } } },
      403: { description: 'Insufficient scope (admin required)', content: { 'application/json': { schema: ApiErrorSchema } } },
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/api/v1/catalog/machines/{typeId}',
    tags: ['PLC Catalog & Output Contract'],
    summary: 'Delete custom PLC profile or reset built-in preset (scope: admin)',
    security: allAuthSecurity,
    request: { params: z.object({ typeId: z.string() }) },
    responses: {
      200: {
        description: 'Profile removed or restored to factory preset',
        content: { 'application/json': { schema: PlcCatalogDeleteResponseSchema } },
      },
      404: { description: 'PLC profile not found', content: { 'application/json': { schema: ApiErrorSchema } } },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/catalog/machines/{typeId}/preview-output',
    tags: ['PLC Catalog & Output Contract'],
    summary: 'Preview parameterized telemetry, ML window, and BA KPI output (scope: read)',
    description:
      'Generates a sample Common Telemetry Envelope, parameterized ML Feature row (honoring `fields[]`), and BA KPI row based on the chosen PLC catalog definition.',
    security: allAuthSecurity,
    request: {
      params: z.object({ typeId: z.string() }),
      body: {
        required: false,
        content: { 'application/json': { schema: PlcOutputPreviewRequestSchema } },
      },
    },
    responses: {
      200: {
        description: 'Parameterized PLC output preview',
        content: { 'application/json': { schema: PlcOutputPreviewResponseSchema } },
      },
      404: { description: 'PLC profile not found', content: { 'application/json': { schema: ApiErrorSchema } } },
    },
  });

  // Ingestion & Edge Gateway
  registry.registerPath({
    method: 'post',
    path: '/api/v1/ingest/batch',
    tags: ['Ingestion & Edge Gateway'],
    summary: 'Ingest normalized Common Telemetry Envelope batches',
    description:
      '**Two-Tier Validation Contract:**\n- **Tier 1 (`permissive`, default):** Accepts `{ events: [...] }` or single `{ event: {...} }`, supports flat metrics or nested `metrics: {...}`, and isolates malformed individual records into the SHA-256 Quarantine Sink while returning `202 Accepted`.\n- **Tier 2 (`X-Validation-Mode: strict`):** Rejects the entire batch with `400 Bad Request` if any event violates strict ISO-8601 UTC, range, or schema rules.',
    security: [{ GatewayBearerAuth: [] }, { GatewayHeaderAuth: [] }],
    request: {
      headers: validationModeHeader,
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z.union([IngestBatchStrictSchema, IngestBatchPermissiveSchema]),
          },
        },
      },
    },
    responses: {
      202: {
        description: 'Batch processed into active ML/BA pipeline',
        content: { 'application/json': { schema: IngestBatchResponseSchema } },
      },
      400: { description: 'Validation error', content: { 'application/json': { schema: ApiErrorSchema } } },
      401: { description: 'Missing or invalid Edge Gateway token', content: { 'application/json': { schema: ApiErrorSchema } } },
      413: { description: 'Batch exceeds 5,000 events per call', content: { 'application/json': { schema: ApiErrorSchema } } },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/edge/config',
    tags: ['Ingestion & Edge Gateway'],
    summary: 'Plug & Play Edge Collector auto-sync configuration',
    description:
      'Polled every 30s by Python `edge_gateway.collector` (`--config-url`) to hot-reload new PLC endpoints configured in the Web Console without restarting containers.',
    security: [{ GatewayBearerAuth: [] }, { GatewayHeaderAuth: [] }],
    responses: {
      200: {
        description: 'Active PLC/Meter connections & ingest target hash',
        content: { 'application/json': { schema: EdgeConfigResponseSchema } },
      },
      401: { description: 'Missing or invalid Edge Gateway token', content: { 'application/json': { schema: ApiErrorSchema } } },
    },
  });

  // Plant Connections
  registry.registerPath({
    method: 'get',
    path: '/api/v1/connections',
    tags: ['Plant Connections'],
    summary: 'List configured PLC & industrial meter endpoints (scope: read)',
    security: allAuthSecurity,
    responses: {
      200: {
        description: 'Network settings and connection list',
        content: { 'application/json': { schema: ConnectionsStateResponseSchema } },
      },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/connections',
    tags: ['Plant Connections'],
    summary: 'Create or update a PLC/Meter endpoint (scope: admin)',
    security: allAuthSecurity,
    request: {
      headers: validationModeHeader,
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z.union([ConnectionUpsertStrictSchema, ConnectionUpsertPermissiveSchema]),
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Existing connection updated',
        content: { 'application/json': { schema: ConnectionUpsertResponseSchema } },
      },
      201: {
        description: 'New connection created',
        content: { 'application/json': { schema: ConnectionUpsertResponseSchema } },
      },
      400: { description: 'Validation error', content: { 'application/json': { schema: ApiErrorSchema } } },
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/api/v1/connections/settings',
    tags: ['Plant Connections'],
    summary: 'Update corporate OT/IT deployment topology & auth policy (scope: admin)',
    security: allAuthSecurity,
    request: {
      headers: validationModeHeader,
      body: {
        required: true,
        content: {
          'application/json': { schema: NetworkSettingsStrictSchema },
        },
      },
    },
    responses: {
      200: {
        description: 'Network settings updated',
        content: { 'application/json': { schema: ConnectionsStateResponseSchema } },
      },
      400: { description: 'Validation error', content: { 'application/json': { schema: ApiErrorSchema } } },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/connections/gateway-token/rotate',
    tags: ['Plant Connections'],
    summary: 'Issue or rotate Edge Gateway Bearer token (scope: admin)',
    description: 'Returns the plaintext `gw_live_...` token once and stores only its SHA-256 hash.',
    security: allAuthSecurity,
    responses: {
      200: {
        description: 'New Edge token issued',
        content: { 'application/json': { schema: GatewayTokenRotateResponseSchema } },
      },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/connections/api-keys/rotate',
    tags: ['Plant Connections'],
    summary: 'Issue or rotate scoped API key (`edge`, `read`, `admin`) (scope: admin)',
    description:
      'Generates a high-entropy scoped key (`gw_live_...`, `bi_live_...`, or `adm_live_...`), displays it once, and persists only its SHA-256 digest.',
    security: allAuthSecurity,
    request: {
      body: {
        required: true,
        content: { 'application/json': { schema: ScopedKeyRotateRequestSchema } },
      },
    },
    responses: {
      200: {
        description: 'New scoped API key issued',
        content: { 'application/json': { schema: ScopedKeyRotateResponseSchema } },
      },
      400: { description: 'Invalid scope', content: { 'application/json': { schema: ApiErrorSchema } } },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/connections/{id}/probe',
    tags: ['Plant Connections'],
    summary: 'Run SSRF-hardened TCP/HTTP reachability & RTT probe (scope: admin)',
    security: allAuthSecurity,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: {
        description: 'Socket probe result (reachable / SSRF_BLOCKED / ECONNREFUSED / ETIMEDOUT)',
        content: { 'application/json': { schema: ConnectionProbeResponseSchema } },
      },
      404: { description: 'Connection not found', content: { 'application/json': { schema: ApiErrorSchema } } },
      429: { description: 'Rate limit exceeded', content: { 'application/json': { schema: ApiErrorSchema } } },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/connections/{id}/send-test-batch',
    tags: ['Plant Connections'],
    summary: 'Dispatch live test envelope through ingest pipeline (scope: admin)',
    security: allAuthSecurity,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      202: {
        description: 'Test envelope ingested into active ML/BA run',
        content: { 'application/json': { schema: ConnectionTestBatchResponseSchema } },
      },
      404: { description: 'Connection not found', content: { 'application/json': { schema: ApiErrorSchema } } },
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/api/v1/connections/{id}',
    tags: ['Plant Connections'],
    summary: 'Remove a configured PLC/Meter endpoint (scope: admin)',
    security: allAuthSecurity,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: {
        description: 'Connection deleted',
        content: { 'application/json': { schema: ConnectionDeleteResponseSchema } },
      },
      404: { description: 'Connection not found', content: { 'application/json': { schema: ApiErrorSchema } } },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/connections/deploy-bundle',
    tags: ['Plant Connections'],
    summary: 'Generate On-Premise Docker Compose, Edge config & installer script (scope: admin)',
    security: allAuthSecurity,
    responses: {
      200: {
        description: 'Generated deployment bundle',
        content: { 'application/json': { schema: OnPremDeployBundleSchema } },
      },
    },
  });

  // Pipeline Job & ML
  registry.registerPath({
    method: 'get',
    path: '/api/v1/job/config',
    tags: ['Pipeline Job & ML'],
    summary: 'Retrieve active Dataset Builder & Lakehouse job policy (scope: read)',
    security: allAuthSecurity,
    responses: {
      200: {
        description: 'Active job configuration',
        content: { 'application/json': { schema: JobConfigResponseSchema } },
      },
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/api/v1/job/config',
    tags: ['Pipeline Job & ML'],
    summary: 'Update & persist Dataset Builder and Tiering job policy (scope: admin)',
    security: allAuthSecurity,
    request: {
      headers: validationModeHeader,
      body: {
        required: true,
        content: { 'application/json': { schema: JobConfigStrictSchema } },
      },
    },
    responses: {
      200: {
        description: 'Job configuration persisted',
        content: { 'application/json': { schema: JobConfigResponseSchema } },
      },
      400: { description: 'Validation error', content: { 'application/json': { schema: ApiErrorSchema } } },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/pipeline/runs',
    tags: ['Pipeline Job & ML'],
    summary: 'Start real-time multi-domain telemetry simulation stream (scope: admin)',
    security: allAuthSecurity,
    request: {
      headers: validationModeHeader,
      body: {
        required: true,
        content: { 'application/json': { schema: PipelineRunCreateStrictSchema } },
      },
    },
    responses: {
      201: {
        description: 'Simulation stream started',
        content: { 'application/json': { schema: LiveRunSnapshotSchema } },
      },
      400: { description: 'Validation error', content: { 'application/json': { schema: ApiErrorSchema } } },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/pipeline/runs/latest',
    tags: ['Pipeline Job & ML'],
    summary: 'Fetch latest run snapshot (ML windows, logs, quarantine, tiering) (scope: read)',
    security: allAuthSecurity,
    responses: {
      200: {
        description: 'Latest snapshot or null',
        content: { 'application/json': { schema: LatestRunResponseSchema } },
      },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/pipeline/runs/{id}/pause',
    tags: ['Pipeline Job & ML'],
    summary: 'Pause active simulation stream (scope: admin)',
    security: allAuthSecurity,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: {
        description: 'Run paused',
        content: { 'application/json': { schema: LiveRunSnapshotSchema } },
      },
      404: { description: 'Simulation run not found', content: { 'application/json': { schema: ApiErrorSchema } } },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/pipeline/runs/{id}/resume',
    tags: ['Pipeline Job & ML'],
    summary: 'Resume paused simulation stream (scope: admin)',
    security: allAuthSecurity,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: {
        description: 'Run resumed',
        content: { 'application/json': { schema: LiveRunSnapshotSchema } },
      },
      404: { description: 'Simulation run not found', content: { 'application/json': { schema: ApiErrorSchema } } },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/pipeline/runs/{id}/stop',
    tags: ['Pipeline Job & ML'],
    summary: 'Stop active or paused simulation stream (scope: admin)',
    security: allAuthSecurity,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: {
        description: 'Run stopped',
        content: { 'application/json': { schema: LiveRunSnapshotSchema } },
      },
      404: { description: 'Simulation run not found', content: { 'application/json': { schema: ApiErrorSchema } } },
    },
  });

  // Business Analytics & BI Connectors (Power BI / Grafana)
  registry.registerPath({
    method: 'get',
    path: '/api/v1/ba/kpi',
    tags: ['Business Analytics (Grafana & Power BI)'],
    summary: 'Query daily OEE, energy (kWh) & gas volume (Nm3) KPIs (scope: read)',
    description:
      'Power BI Web Connector & Grafana JSON/CSV feed. Supports `?machineType=<typeId>`, `?domain=<domain>`, `?fields=col1,col2,...`, and `?format=csv` (RFC 4180 formula-safe CSV) for Excel/Power BI direct import.',
    security: allAuthSecurity,
    request: {
      query: z.object({
        machineType: z.string().optional(),
        domain: z.enum(DOMAINS).optional(),
        fromDate: z.string().optional(),
        toDate: z.string().optional(),
        source: z.enum(['auto', 'postgres', 'live']).optional(),
        fields: z.string().optional(),
        format: z.enum(['json', 'csv']).optional(),
      }),
    },
    responses: {
      200: {
        description: 'Daily KPI rollup ready for Power BI / Grafana / Controllo di Gestione',
        content: {
          'application/json': { schema: BaKpiResponseSchema },
          'text/csv': { schema: z.string() },
        },
      },
      401: { description: 'Unauthorized', content: { 'application/json': { schema: ApiErrorSchema } } },
    },
  });

  // Notifications & Alerts (Email SMTP / Mailpit + HTTP Webhook)
  registry.registerPath({
    method: 'get',
    path: '/api/v1/alerts',
    tags: ['Notifications & Alerts (SMTP / Mailpit & Webhook)'],
    summary: 'Fetch SMTP/Mailpit channel config, Webhook config, alert rules, and recent events (scope: read)',
    security: allAuthSecurity,
    responses: {
      200: { description: 'Alerts & notification channel state', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/api/v1/alerts/channels',
    tags: ['Notifications & Alerts (SMTP / Mailpit & Webhook)'],
    summary: 'Update SMTP / Mailpit and HTTP Webhook notification channels (scope: admin)',
    security: allAuthSecurity,
    request: {
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z.object({
              smtp: z.record(z.string(), z.unknown()).optional(),
              webhook: z.record(z.string(), z.unknown()).optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: { description: 'Channels updated', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/alerts/rules',
    tags: ['Notifications & Alerts (SMTP / Mailpit & Webhook)'],
    summary: 'Create or update a telemetry threshold alert rule (scope: admin)',
    security: allAuthSecurity,
    request: {
      body: {
        required: true,
        content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } },
      },
    },
    responses: {
      201: { description: 'Alert rule saved', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/alerts/test-channel',
    tags: ['Notifications & Alerts (SMTP / Mailpit & Webhook)'],
    summary: 'Send a live test email via SMTP/Mailpit or HTTP POST via Webhook (scope: admin)',
    security: allAuthSecurity,
    request: {
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z.object({
              channel: z.enum(['email', 'webhook']),
              recipient: z.string().optional(),
              webhookUrl: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: { description: 'Test delivery succeeded', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
      502: { description: 'Target SMTP/Webhook unreachable', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/alerts/smtp/verify',
    tags: ['Notifications & Alerts (SMTP / Mailpit & Webhook)'],
    summary: 'Verify active SMTP server TCP/EHLO/AUTH handshake (scope: admin)',
    security: allAuthSecurity,
    responses: {
      200: { description: 'SMTP server handshake verified', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
      502: { description: 'SMTP server unreachable or auth rejected', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/alerts/smtp/send-test',
    tags: ['Notifications & Alerts (SMTP / Mailpit & Webhook)'],
    summary: 'Send a custom diagnostic test email via configured SMTP settings (scope: admin)',
    security: allAuthSecurity,
    request: {
      body: {
        required: false,
        content: {
          'application/json': {
            schema: z.object({
              recipient: z.string().optional(),
              subject: z.string().optional(),
              body: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: { description: 'Diagnostic email accepted by SMTP server', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
      502: { description: 'SMTP delivery failed', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/alerts/mailpit/status',
    tags: ['Notifications & Alerts (SMTP / Mailpit & Webhook)'],
    summary: 'Query Mailpit API connection status, queue depth, and runtime stats (scope: read)',
    security: allAuthSecurity,
    request: {
      query: z.object({
        apiBaseUrl: z.string().optional(),
      }),
    },
    responses: {
      200: { description: 'Mailpit connection & queue status', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
      502: { description: 'Mailpit API unreachable', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/alerts/mailpit/messages',
    tags: ['Notifications & Alerts (SMTP / Mailpit & Webhook)'],
    summary: 'Query captured test emails from Mailpit REST API (scope: read)',
    security: allAuthSecurity,
    request: {
      query: z.object({
        limit: z.coerce.number().int().optional(),
        query: z.string().optional(),
        apiBaseUrl: z.string().optional(),
      }),
    },
    responses: {
      200: { description: 'Mailpit inbox messages', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
      502: { description: 'Mailpit API unreachable', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/alerts/mailpit/messages/{id}',
    tags: ['Notifications & Alerts (SMTP / Mailpit & Webhook)'],
    summary: 'Inspect a single Mailpit message body, HTML, and headers (scope: read)',
    security: allAuthSecurity,
    request: {
      params: z.object({ id: z.string() }),
      query: z.object({ apiBaseUrl: z.string().optional() }),
    },
    responses: {
      200: { description: 'Mailpit message detail', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
      502: { description: 'Mailpit API unreachable or message not found', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/api/v1/alerts/mailpit/messages',
    tags: ['Notifications & Alerts (SMTP / Mailpit & Webhook)'],
    summary: 'Clear all captured messages in Mailpit inbox (scope: admin)',
    security: allAuthSecurity,
    request: {
      query: z.object({ apiBaseUrl: z.string().optional() }),
    },
    responses: {
      200: { description: 'Mailpit inbox cleared', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
      502: { description: 'Mailpit API unreachable', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
    },
  });

  // Users, RBAC & Audit Log
  registry.registerPath({
    method: 'post',
    path: '/api/v1/auth/login',
    tags: ['Users, RBAC & Audit Log'],
    summary: 'Authenticate operator with email & password to issue revocable session token',
    request: {
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z.object({ email: z.string().email(), password: z.string().min(1) }),
          },
        },
      },
    },
    responses: {
      200: { description: 'Session issued', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
      401: { description: 'Invalid credentials', content: { 'application/json': { schema: ApiErrorSchema } } },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/users',
    tags: ['Users, RBAC & Audit Log'],
    summary: 'List RBAC operator accounts (scope: read)',
    security: allAuthSecurity,
    responses: {
      200: { description: 'User list', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/users',
    tags: ['Users, RBAC & Audit Log'],
    summary: 'Create a new RBAC user (admin / operator / viewer) (scope: admin)',
    security: allAuthSecurity,
    request: {
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z.object({
              email: z.string().email(),
              fullName: z.string(),
              role: z.enum(['admin', 'operator', 'viewer']),
              password: z.string().min(8),
            }),
          },
        },
      },
    },
    responses: {
      201: { description: 'User created', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/audit/logs',
    tags: ['Users, RBAC & Audit Log'],
    summary: 'Query immutable Audit Log (JSON or CSV) (scope: read)',
    security: allAuthSecurity,
    request: {
      query: z.object({
        action: z.string().optional(),
        actor: z.string().optional(),
        status: z.enum(['ok', 'denied', 'error']).optional(),
        limit: z.coerce.number().int().optional(),
        format: z.enum(['json', 'csv']).optional(),
      }),
    },
    responses: {
      200: { description: 'Audit log entries', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/roles/permissions',
    tags: ['Users, RBAC & Audit Log'],
    summary: 'Get configurable ERP Role Permissions Matrix (menu views & capabilities per role) (scope: read)',
    security: allAuthSecurity,
    responses: {
      200: { description: 'Role permissions matrix', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/api/v1/roles/permissions',
    tags: ['Users, RBAC & Audit Log'],
    summary: 'Update ERP Role Permissions Matrix for operator and viewer roles (admin stays locked to full access) (scope: admin)',
    security: allAuthSecurity,
    request: {
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z.object({
              matrix: z.record(z.string(), z.unknown()),
            }),
          },
        },
      },
    },
    responses: {
      200: { description: 'Updated role permissions matrix', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
      403: { description: 'Forbidden (admin role required)', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
    },
  });

  // Managed API Keys (X-API-Key / Bearer)
  registry.registerPath({
    method: 'get',
    path: '/api/v1/tokens',
    tags: ['Users, RBAC & Audit Log'],
    summary: 'List managed API keys and usage telemetry (secrets never returned) (scope: read)',
    description:
      'Returns metadata, scopes, expiration, last-used IP, and call counters for all issued `pat_live_...` API keys. Plaintext keys are never stored; only AES-256-GCM encrypted SHA-256 hashes persist at rest.',
    security: allAuthSecurity,
    responses: {
      200: { description: 'Managed API key inventory and summary counts', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
      401: { description: 'Unauthorized', content: { 'application/json': { schema: ApiErrorSchema } } },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/tokens',
    tags: ['Users, RBAC & Audit Log'],
    summary: 'Issue a new scoped X-API-Key (returned once, stored encrypted at rest) (scope: admin)',
    description:
      'Generates a high-entropy `pat_live_...` API key bound to an owner account and least-privilege scopes (`read`, `edge`, `admin`) with optional TTL. The plaintext key is returned once in the response and immediately protected at rest via AES-256-GCM over its SHA-256 digest.',
    security: allAuthSecurity,
    request: {
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z.object({
              name: z.string().min(2).max(80),
              description: z.string().max(240).optional(),
              scopes: z.array(z.enum(['read', 'edge', 'admin'])).min(1),
              ttlHours: z.number().int().min(1).max(87600).nullable().optional(),
              ownerUserId: z.string().optional(),
              ownerEmail: z.string().email().optional(),
              isSandbox: z.boolean().optional(),
            }),
          },
        },
      },
    },
    responses: {
      201: { description: 'API key issued (plaintext shown once)', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
      400: { description: 'Invalid key parameters', content: { 'application/json': { schema: ApiErrorSchema } } },
      403: { description: 'Forbidden (admin required)', content: { 'application/json': { schema: ApiErrorSchema } } },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/tokens/sandbox',
    tags: ['Users, RBAC & Audit Log'],
    summary: 'Mint a short-lived 1-hour sandbox X-API-Key for Scalar or integration testing',
    description:
      'Issues a bounded 1-hour sandbox API key (`pat_live_...`). In strict auth mode (`API_ENFORCE_AUTH=true`), requires valid operator email & password or an active admin credential; in local dev mode, accepts a test role preset (`admin`, `operator`, `viewer`).',
    security: allAuthSecurity,
    request: {
      body: {
        required: false,
        content: {
          'application/json': {
            schema: z.object({
              email: z.string().email().optional(),
              password: z.string().optional(),
              role: z.enum(['admin', 'operator', 'viewer']).optional(),
              name: z.string().max(80).optional(),
            }),
          },
        },
      },
    },
    responses: {
      201: { description: '1-hour sandbox API key minted', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
      401: { description: 'Authentication required in strict mode', content: { 'application/json': { schema: ApiErrorSchema } } },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/tokens/{id}/rotate',
    tags: ['Users, RBAC & Audit Log'],
    summary: 'Atomically rotate an API key (revokes previous key and returns new secret once) (scope: admin)',
    security: allAuthSecurity,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      201: { description: 'Replacement API key issued and previous key revoked', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
      404: { description: 'API key not found', content: { 'application/json': { schema: ApiErrorSchema } } },
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/api/v1/tokens/{id}',
    tags: ['Users, RBAC & Audit Log'],
    summary: 'Immediately revoke an API key (scope: admin)',
    security: allAuthSecurity,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: { description: 'API key revoked', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
      404: { description: 'API key not found', content: { 'application/json': { schema: ApiErrorSchema } } },
    },
  });

  const generator = new OpenApiGeneratorV31(registry.definitions);
  const doc = generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: locale.info.title,
      version: APP_VERSION,
      description: locale.info.description.join('\n'),
    },
    tags: Object.values(locale.tags).map((t) => ({
      name: t.name,
      description: t.description,
    })),
    servers: [
      ...(serverOrigin ? [{ url: serverOrigin, description: locale.info.serverCurrentHost }] : []),
      { url: '/', description: locale.info.serverRelativeOrigin },
    ],
  });

  // Apply localized tag names and operation summaries from src/i18n/locales/{en,it}/openapi.json
  const pathsRecord = (doc.paths ?? {}) as Record<string, Record<string, { summary?: string; tags?: string[] }>>;
  for (const [routePath, pathItem] of Object.entries(pathsRecord)) {
    for (const [method, operation] of Object.entries(pathItem ?? {})) {
      if (!operation || typeof operation !== 'object') continue;
      const opKey = `${method.toUpperCase()} ${routePath}`;
      if (locale.operations[opKey]) {
        operation.summary = locale.operations[opKey];
      }
      if (Array.isArray(operation.tags)) {
        operation.tags = operation.tags.map((tagKey) => locale.tags[tagKey]?.name ?? tagKey);
      }
    }
  }

  return doc;
}
