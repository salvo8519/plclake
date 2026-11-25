export type MachineState = 'IDLE' | 'RUNNING' | 'DEGRADED' | 'FAULT' | 'MAINTENANCE';
export type LogLevel = 'INFO' | 'WARN' | 'ERROR';
export type MachineDomain = 'manufacturing' | 'gas-metering' | 'power-generation';

export interface RawMachineEvent {
  event_id: string;
  timestamp: string;
  site_id?: string;
  machine_id: string;
  line_id: string;
  machine_type: string;
  domain: MachineDomain;
  state: MachineState;
  error_code: string | null;
  temp_c: number;
  vibration_mm_s: number;
  cycle_ms: number;
  primary_metric_name: string;
  primary_metric_value: number;
  primary_metric_unit: string;
  secondary_metric_name: string;
  secondary_metric_value: number;
  secondary_metric_unit: string;
  metrics: Record<string, number>;
  payload_valid: boolean;
  level: LogLevel;
}

export interface QuarantineRecord {
  quarantine_id: string;
  quarantined_at: string;
  source: 'simulator' | 'dataset_builder' | 'http_ingest';
  error_reason: string;
  raw_payload: string;
}

export interface MlFeatureRow {
  site_id?: string;
  machine_id: string;
  window_start: string;
  window_minutes: number;
  dt: string;
  line_id: string;
  machine_type: string;
  domain: MachineDomain;
  sample_count: number;
  valid_sample_ratio: number;
  primary_metric_name: string;
  primary_metric_unit: string;
  primary_metric_mean: number;
  primary_metric_p95: number;
  primary_metric_max: number;
  secondary_metric_name: string;
  secondary_metric_unit: string;
  secondary_metric_mean: number;
  temp_mean: number;
  temp_max: number;
  vibration_mean: number;
  vibration_p95: number;
  vibration_max: number;
  cycle_ms_mean: number;
  cycle_ms_std: number;
  error_count: number;
  fault_count: number;
  degraded_count: number;
  state_transitions_count: number;
  time_in_fault_sec: number;
  missing_heartbeat_count: number;
  is_anomalous_window: number;
  will_fail_next_window: number | null;
  dataset_version: string;
  custom_metrics_avg?: Record<string, number>;
}

export interface LogSegmentInfo {
  name: string;
  lines: number;
  sizeBytes: number;
  rotatedAt: string;
  s3Key: string;
}

export interface LiveLogFeedEntry {
  seq: number;
  timestamp: string;
  machine_id: string;
  line_id: string;
  machine_type: string;
  domain: MachineDomain;
  state: MachineState | 'CORRUPT';
  level: LogLevel | 'QUARANTINE';
  temp_c: number | null;
  vibration_mm_s: number | null;
  cycle_ms: number | null;
  primary_metric_name: string | null;
  primary_metric_value: number | null;
  primary_metric_unit: string | null;
  quarantined: boolean;
  error_reason: string | null;
  raw: string;
}

export type LiveRunStatus = 'running' | 'paused' | 'completed' | 'stopped';

export type MachineProfileMode = string;

export type PartitionLayout =
  | 'domain/dt'
  | 'dt/machine_id'
  | 'dt/line_id/machine_id'
  | 'dt/hour/machine_id';

export type LakehouseFormat = 'duckdb-parquet-compacted' | 'hive-parquet-append';
export type ColdStorageEndpoint = 'garage-s3-cold' | 's3-glacier-compatible' | 'nas-cold-archive';
export type CompactionSchedule = 'hourly' | 'daily-01utc' | 'weekly-sun';
export type IngestTransport = 'local-segments' | 'http-batch-ingest';

export interface LiveRunConfig {
  durationMinutes: number;
  eventsPerSec: number;
  speedMultiplier: 1 | 10 | 60 | 300;
  windowMinutes: number;
  machineCount: number;
  machinesPerLine: number;
  machineProfileMode: MachineProfileMode;
  selectedPlcTypes?: string[];
  outputFields?: string[];
  faultProbabilityPct: number;
  malformedRatePct: number;
  outOfOrderRatePct: number;
  rotateMaxLines: number;
  seed: number;
  customMachineTopology?: string;
  ignoredErrorCodes?: string;
  horizonWindows?: number;
  tempAnomalyThresholdC?: number;
  vibrationP95Threshold?: number;
  minValidSampleRatio?: number;
  dedupStrategy?: 'event_id_strict' | 'event_id_plus_timestamp';
  malformedPolicy?: 'quarantine_sha256' | 'drop_and_count' | 'halt_on_error';
  parquetCompression?: 'zstd' | 'snappy' | 'gzip';
  datasetVersion?: string;
  partitionLayout?: PartitionLayout;
  lakehouseFormat?: LakehouseFormat;
  hotRetentionDays?: number;
  coldRetentionDays?: number;
  coldStorageEndpoint?: ColdStorageEndpoint;
  compactionSchedule?: CompactionSchedule;
  ingestTransport?: IngestTransport;
}

export interface TieringSummary {
  hotStoreLabel: string;
  hotRetentionDays: number;
  coldStoreLabel: string;
  coldRetentionDays: number;
  lakehouseFormat: LakehouseFormat;
  compactionSchedule: CompactionSchedule;
  ingestTransport: IngestTransport;
  estimatedColdParquetMb: number;
  compactedFileCountEst: number;
}

export interface LiveRunSnapshot {
  runId: string;
  status: LiveRunStatus;
  config: LiveRunConfig;
  startedAt: string;
  updatedAt: string;
  elapsedWallSec: number;
  elapsedSimSec: number;
  targetSimSec: number;
  progressPct: number;
  totalCallsEmitted: number;
  targetTotalCalls: number;
  effectiveRatePerSec: number;
  validEventsCount: number;
  quarantinedCount: number;
  outOfOrderCount: number;
  rotatedSegmentsCount: number;
  highWatermarkIso: string | null;
  expectedSampleSec: number;
  anomalousWindowsCount: number;
  featureRowsCount: number;
  tieringSummary: TieringSummary;
  recentLogs: LiveLogFeedEntry[];
  segments: LogSegmentInfo[];
  quarantineRecords: QuarantineRecord[];
  features: MlFeatureRow[];
  partitionPaths: string[];
}

export interface JobConfig {
  environment: 'local' | 'staging' | 'production';
  executionMode: 'continuous-watch' | 'one-shot-batch';
  watchIntervalSec: 10 | 30 | 60 | 300;
  windowMinutes: 1 | 5 | 15;
  watermarkLookbackMin: 5 | 15 | 30 | 60;
  horizonWindows: 1 | 2 | 3;
  rotateMaxLines: 250 | 500 | 1000 | 2000 | 5000;
  dedupStrategy: 'event_id_strict' | 'event_id_plus_timestamp';
  malformedPolicy: 'quarantine_sha256' | 'drop_and_count' | 'halt_on_error';
  timestampMode: 'utc_iso8601_strict' | 'utc_coerced';
  machineProfileMode: MachineProfileMode;
  machinesPerLine: 1 | 2 | 4 | 8;
  tempAnomalyThresholdC: 75 | 82 | 90 | 95;
  vibrationP95Threshold: 2.5 | 3.5 | 4.5 | 6.0;
  minValidSampleRatio: 0.5 | 0.75 | 0.85 | 0.95;
  datasetVersion: 'v1.0.0' | 'v1.1.0' | 'v2.0.0-rc1';
  storageTarget: 'garage-s3' | 'rustfs-s3' | 'local-fs';
  parquetCompression: 'zstd' | 'snappy' | 'gzip';
  partitionLayout: PartitionLayout;
  featureMartSink: 'postgres-upsert' | 'parquet-only';
  hotRetentionDays: 7 | 30 | 90 | 180;
  coldRetentionDays: 180 | 365 | 1095 | 1825;
  coldStorageEndpoint: ColdStorageEndpoint;
  lakehouseFormat: LakehouseFormat;
  compactionSchedule: CompactionSchedule;
  ingestTransport: IngestTransport;
  customMachineTopology: string;
  ignoredErrorCodes: string;
}

export interface JobConfigResponse {
  config: JobConfig;
  updatedAt: string;
}

export interface BusinessAnalyticsKpiRow {
  dt: string;
  domain: MachineDomain;
  line_id: string;
  machine_id: string;
  machine_type: string;
  observed_windows: number;
  total_samples: number;
  monitored_hours: number;
  downtime_fault_hours: number;
  availability_oee_pct: number;
  anomalous_windows: number;
  primary_metric_name: string;
  primary_metric_unit: string;
  primary_metric_avg: number;
  estimated_energy_kwh: number;
  estimated_gas_volume_nm3: number;
}

export type ConnectionProtocol = 'opcua' | 'modbus-tcp' | 'mqtt-sparkplug' | 'http-rest-meter';
export type DeploymentTopology = 'on-premise-lan' | 'site-to-site-vpn' | 'edge-gateway-push';
export type ConnectionAuthMode = 'anonymous' | 'username-password' | 'x509-cert' | 'bearer-token';
export type ConnectionStatus = 'configured' | 'connected' | 'unreachable' | 'disabled';

export interface TagBinding {
  sourceTag: string;
  targetMetric: string;
  scaleFactor: number;
  unit: string;
}

export interface PlcConnection {
  id: string;
  name: string;
  machineId: string;
  lineId: string;
  machineType: string;
  protocol: ConnectionProtocol;
  deploymentTopology: DeploymentTopology;
  host: string;
  port: number;
  endpointOrTopic: string;
  pollIntervalSec: 1 | 2 | 5 | 10 | 30;
  authMode: ConnectionAuthMode;
  username?: string;
  enabled: boolean;
  status: ConnectionStatus;
  lastProbeAt: string | null;
  lastLatencyMs: number | null;
  lastError: string | null;
  samplesIngested: number;
  tagBindings: TagBinding[];
}

export interface NetworkDeploymentSettings {
  topologyMode: DeploymentTopology;
  siteName: string;
  plantVlanCidr: string;
  ingestApiUrl: string;
  requireGatewayToken: boolean;
  spoolMaxMb: 256 | 1024 | 4096;
  tokenFingerprint: string | null;
  tokenUpdatedAt: string | null;
  readTokenFingerprint?: string | null;
  adminTokenFingerprint?: string | null;
}

export interface ConnectionProbeResult {
  connectionId: string;
  reachable: boolean;
  protocol: ConnectionProtocol;
  host: string;
  port: number;
  latencyMs: number | null;
  checkedAt: string;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface ConnectionsStateResponse {
  settings: NetworkDeploymentSettings;
  connections: PlcConnection[];
  updatedAt: string;
}

export interface OnPremDeployBundle {
  generatedAt: string;
  topologyMode: DeploymentTopology;
  edgeConnectionsJson: string;
  edgeEnvFile: string;
  onPremComposeYml: string;
  installScriptSh: string;
}

export type PlcBaFormula =
  | 'oee_cycle_count'
  | 'gas_nm3_integration'
  | 'energy_kwh_integration'
  | 'custom_throughput';

export interface PlcExtraChannelSpec {
  key: string;
  unit: string;
  nominal: number;
  std: number;
}

export interface PlcCatalogProfile {
  typeId: string;
  label: string;
  vendorFamily: string;
  domain: MachineDomain;
  defaultProtocol: ConnectionProtocol;
  defaultPort: number;
  isBuiltIn: boolean;
  primaryKey: string;
  primaryUnit: string;
  primaryNominal: number;
  primaryStd: number;
  primaryFaultThreshold: number;
  primaryFaultLowThreshold?: number;
  secondaryKey: string;
  secondaryUnit: string;
  secondaryNominal: number;
  secondaryStd: number;
  secondaryFaultThreshold?: number;
  tempNominalC: number;
  tempStdC: number;
  tempFaultThresholdC: number;
  extraChannels: PlcExtraChannelSpec[];
  defaultOutputFields: string[];
  baFormula: PlcBaFormula;
  updatedAt: string;
}

export interface PlcCatalogListResponse {
  profiles: PlcCatalogProfile[];
  availableOutputFields: string[];
  updatedAt: string;
}

export type UserRole = 'admin' | 'operator' | 'viewer';

export interface UserAccountPublic {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  active: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface SessionUserInfo {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  authSource: 'session' | 'oidc-proxy';
}

export interface AuditLogEntry {
  id: string;
  timestamp: string;
  actor: string;
  actorRole: string;
  action: string;
  resource: string;
  status: 'ok' | 'denied' | 'error';
  requestId: string;
  details: Record<string, unknown>;
}

export type AlertMetric =
  | 'temp_max'
  | 'temp_mean'
  | 'primary_metric_mean'
  | 'primary_metric_p95'
  | 'fault_count'
  | 'is_anomalous_window'
  | 'availability_pct';

export type AlertOperator = 'gt' | 'gte' | 'lt' | 'lte';
export type AlertSeverity = 'info' | 'warning' | 'critical';
export type AlertChannelType = 'email' | 'webhook';

export interface SmtpChannelConfig {
  enabled: boolean;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  passwordSet: boolean;
  fromAddress: string;
  recipients: string[];
  mailpitUiUrl: string;
}

export interface WebhookChannelConfig {
  enabled: boolean;
  url: string;
  signingSecretSet: boolean;
  timeoutMs: number;
}

export interface AlertRule {
  id: string;
  name: string;
  enabled: boolean;
  metric: AlertMetric;
  operator: AlertOperator;
  threshold: number;
  severity: AlertSeverity;
  channels: AlertChannelType[];
  cooldownSec: number;
  domainFilter?: MachineDomain | null;
  machineTypeFilter?: string | null;
  updatedAt: string;
}

export interface AlertDeliveryOutcome {
  channel: AlertChannelType;
  status: 'sent' | 'failed' | 'skipped';
  target: string;
  messageId?: string | null;
  httpStatus?: number | null;
  error?: string | null;
  sentAt: string;
}

export interface AlertEventHistoryEntry {
  action: 'acknowledged' | 'reopened' | 'note_updated';
  actor: string;
  at: string;
  note?: string | null;
}

export interface AlertEvent {
  id: string;
  ruleId: string;
  ruleName: string;
  severity: AlertSeverity;
  machineId: string;
  lineId: string;
  machineType: string;
  domain: MachineDomain;
  metric: AlertMetric;
  observedValue: number;
  threshold: number;
  message: string;
  triggeredAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  acknowledgementNote?: string | null;
  reopenedAt?: string | null;
  reopenedBy?: string | null;
  actionHistory?: AlertEventHistoryEntry[];
  deliveries: AlertDeliveryOutcome[];
}

export interface AlertsStateResponse {
  smtp: SmtpChannelConfig;
  webhook: WebhookChannelConfig;
  rules: AlertRule[];
  recentEvents: AlertEvent[];
  updatedAt: string;
}

export interface SmtpVerifyResult {
  reachable: boolean;
  host: string;
  port: number;
  secure: boolean;
  authConfigured: boolean;
  latencyMs: number;
  checkedAt: string;
  error?: string | null;
}

export interface SmtpDiagnosticSendResult {
  outcome: AlertDeliveryOutcome;
  latencyMs: number;
  smtpResponse?: string | null;
  subject: string;
  recipients: string[];
}

export interface MailpitAddress {
  Name: string;
  Address: string;
}

export interface MailpitMessageSummary {
  id: string;
  messageId: string;
  from: string;
  to: string[];
  subject: string;
  snippet: string;
  createdAt: string;
  sizeBytes: number;
  read: boolean;
  attachments: number;
}

export interface MailpitMessagesResponse {
  reachable: boolean;
  apiBaseUrl: string;
  latencyMs: number;
  checkedAt: string;
  total: number;
  unread: number;
  messagesCount: number;
  messages: MailpitMessageSummary[];
  error?: string | null;
}

export interface MailpitMessageDetail {
  id: string;
  messageId: string;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  createdAt: string;
  sizeBytes: number;
  text: string;
  html: string;
  headers: Record<string, string[]>;
}

export interface MailpitMessageDetailResponse {
  reachable: boolean;
  apiBaseUrl: string;
  message: MailpitMessageDetail | null;
  error?: string | null;
}

export interface MailpitStatusResponse {
  connected: boolean;
  apiBaseUrl: string;
  latencyMs: number;
  checkedAt: string;
  queueDepth: number;
  unreadCount: number;
  version: string | null;
  databaseSizeBytes: number | null;
  uptimeSec: number | null;
  smtpAccepted: number | null;
  smtpRejected: number | null;
  error?: string | null;
}

export type AppViewId =
  | 'workbench'
  | 'fleet'
  | 'connections'
  | 'plc_catalog'
  | 'job_config'
  | 'notifications'
  | 'users'
  | 'roles'
  | 'tokens'
  | 'audit';

export type ApiTokenScope = 'read' | 'edge' | 'admin';
export type ApiTokenStatus = 'active' | 'expiring_soon' | 'expired' | 'revoked';

export interface ApiTokenPublic {
  id: string;
  name: string;
  description: string;
  tokenPrefix: string;
  scopes: ApiTokenScope[];
  ownerUserId: string;
  ownerEmail: string;
  ownerRole: UserRole;
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  usageCount: number;
  revokedAt: string | null;
  revokedBy: string | null;
  revokedReason: string | null;
  isSandbox: boolean;
  status: ApiTokenStatus;
}

export interface ApiTokenListResponse {
  tokens: ApiTokenPublic[];
  summary: {
    total: number;
    active: number;
    expiringSoon: number;
    revokedOrExpired: number;
    totalUsageCount: number;
  };
  authEnforced: boolean;
}

export interface ApiTokenIssueResponse {
  token: string;
  record: ApiTokenPublic;
  warning: string;
}

export interface ApiTokenWhoAmIResponse {
  authenticated: boolean;
  credentialType: 'api-token' | 'session' | 'gateway-key' | 'oidc-proxy' | 'anonymous';
  actor: string;
  role: string;
  scopes: ApiTokenScope[];
  tokenId: string | null;
  tokenName: string | null;
  tokenPrefix: string | null;
  expiresAt: string | null;
  isSandbox: boolean;
  authEnforced: boolean;
}

export interface RolePermissionPolicy {
  allowedViews: AppViewId[];
  canControlSimulation: boolean;
  canWriteConfig: boolean;
  canManageAlerts: boolean;
  canManageUsers: boolean;
}

export type RolePermissionsMatrix = Record<UserRole, RolePermissionPolicy>;

export interface RolePermissionsResponse {
  matrix: RolePermissionsMatrix;
  updatedAt: string;
}

export interface AuthMeResponse {
  user: SessionUserInfo | null;
  authEnforced: boolean;
  permissions: RolePermissionPolicy;
}


