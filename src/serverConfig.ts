import { getAllCatalogProfiles } from './machineCatalog.ts';
import type { JobConfig } from './types/pipeline.ts';

export const DEFAULT_JOB_CONFIG: JobConfig = {
  environment: 'production',
  executionMode: 'continuous-watch',
  watchIntervalSec: 30,
  windowMinutes: 5,
  watermarkLookbackMin: 15,
  horizonWindows: 1,
  rotateMaxLines: 1000,
  dedupStrategy: 'event_id_strict',
  malformedPolicy: 'quarantine_sha256',
  timestampMode: 'utc_iso8601_strict',
  machineProfileMode: 'mixed',
  machinesPerLine: 2,
  tempAnomalyThresholdC: 82,
  vibrationP95Threshold: 3.5,
  minValidSampleRatio: 0.75,
  datasetVersion: 'v1.0.0',
  storageTarget: 'garage-s3',
  parquetCompression: 'zstd',
  partitionLayout: 'domain/dt',
  featureMartSink: 'postgres-upsert',
  hotRetentionDays: 90,
  coldRetentionDays: 1095,
  coldStorageEndpoint: 'garage-s3-cold',
  lakehouseFormat: 'duckdb-parquet-compacted',
  compactionSchedule: 'daily-01utc',
  ingestTransport: 'local-segments',
  customMachineTopology: '',
  ignoredErrorCodes: 'E_SENSOR_CAL, E_MAINT_TEST',
};

export function sanitizeJobConfig(body: Partial<JobConfig>, fallback: JobConfig): JobConfig {
  return {
    environment:
      body.environment === 'local' || body.environment === 'staging' || body.environment === 'production'
        ? body.environment
        : fallback.environment,
    executionMode:
      body.executionMode === 'continuous-watch' || body.executionMode === 'one-shot-batch'
        ? body.executionMode
        : fallback.executionMode,
    watchIntervalSec: [10, 30, 60, 300].includes(Number(body.watchIntervalSec))
      ? (Number(body.watchIntervalSec) as JobConfig['watchIntervalSec'])
      : fallback.watchIntervalSec,
    windowMinutes: [1, 5, 15].includes(Number(body.windowMinutes))
      ? (Number(body.windowMinutes) as JobConfig['windowMinutes'])
      : fallback.windowMinutes,
    watermarkLookbackMin: [5, 15, 30, 60].includes(Number(body.watermarkLookbackMin))
      ? (Number(body.watermarkLookbackMin) as JobConfig['watermarkLookbackMin'])
      : fallback.watermarkLookbackMin,
    horizonWindows: [1, 2, 3].includes(Number(body.horizonWindows))
      ? (Number(body.horizonWindows) as JobConfig['horizonWindows'])
      : fallback.horizonWindows,
    rotateMaxLines: [250, 500, 1000, 2000, 5000].includes(Number(body.rotateMaxLines))
      ? (Number(body.rotateMaxLines) as JobConfig['rotateMaxLines'])
      : fallback.rotateMaxLines,
    dedupStrategy:
      body.dedupStrategy === 'event_id_strict' || body.dedupStrategy === 'event_id_plus_timestamp'
        ? body.dedupStrategy
        : fallback.dedupStrategy,
    malformedPolicy:
      body.malformedPolicy === 'quarantine_sha256' ||
      body.malformedPolicy === 'drop_and_count' ||
      body.malformedPolicy === 'halt_on_error'
        ? body.malformedPolicy
        : fallback.malformedPolicy,
    timestampMode:
      body.timestampMode === 'utc_iso8601_strict' || body.timestampMode === 'utc_coerced'
        ? body.timestampMode
        : fallback.timestampMode,
    machineProfileMode:
      typeof body.machineProfileMode === 'string' &&
      (body.machineProfileMode === 'mixed' ||
        body.machineProfileMode === 'manufacturing' ||
        body.machineProfileMode === 'gas-metering' ||
        body.machineProfileMode === 'power-generation' ||
        getAllCatalogProfiles().some((p) => p.typeId === body.machineProfileMode))
        ? body.machineProfileMode
        : fallback.machineProfileMode,
    machinesPerLine: [1, 2, 4, 8].includes(Number(body.machinesPerLine))
      ? (Number(body.machinesPerLine) as JobConfig['machinesPerLine'])
      : fallback.machinesPerLine,
    tempAnomalyThresholdC: [75, 82, 90, 95].includes(Number(body.tempAnomalyThresholdC))
      ? (Number(body.tempAnomalyThresholdC) as JobConfig['tempAnomalyThresholdC'])
      : fallback.tempAnomalyThresholdC,
    vibrationP95Threshold: [2.5, 3.5, 4.5, 6.0].includes(Number(body.vibrationP95Threshold))
      ? (Number(body.vibrationP95Threshold) as JobConfig['vibrationP95Threshold'])
      : fallback.vibrationP95Threshold,
    minValidSampleRatio: [0.5, 0.75, 0.85, 0.95].includes(Number(body.minValidSampleRatio))
      ? (Number(body.minValidSampleRatio) as JobConfig['minValidSampleRatio'])
      : fallback.minValidSampleRatio,
    datasetVersion:
      body.datasetVersion === 'v1.0.0' ||
      body.datasetVersion === 'v1.1.0' ||
      body.datasetVersion === 'v2.0.0-rc1'
        ? body.datasetVersion
        : fallback.datasetVersion,
    storageTarget:
      body.storageTarget === 'garage-s3' ||
      body.storageTarget === 'rustfs-s3' ||
      body.storageTarget === 'local-fs'
        ? body.storageTarget
        : fallback.storageTarget,
    parquetCompression:
      body.parquetCompression === 'zstd' ||
      body.parquetCompression === 'snappy' ||
      body.parquetCompression === 'gzip'
        ? body.parquetCompression
        : fallback.parquetCompression,
    partitionLayout:
      body.partitionLayout === 'domain/dt' ||
      body.partitionLayout === 'dt/machine_id' ||
      body.partitionLayout === 'dt/line_id/machine_id' ||
      body.partitionLayout === 'dt/hour/machine_id'
        ? body.partitionLayout
        : fallback.partitionLayout,
    featureMartSink:
      body.featureMartSink === 'postgres-upsert' || body.featureMartSink === 'parquet-only'
        ? body.featureMartSink
        : fallback.featureMartSink,
    hotRetentionDays: [7, 30, 90, 180].includes(Number(body.hotRetentionDays))
      ? (Number(body.hotRetentionDays) as JobConfig['hotRetentionDays'])
      : fallback.hotRetentionDays,
    coldRetentionDays: [180, 365, 1095, 1825].includes(Number(body.coldRetentionDays))
      ? (Number(body.coldRetentionDays) as JobConfig['coldRetentionDays'])
      : fallback.coldRetentionDays,
    coldStorageEndpoint:
      body.coldStorageEndpoint === 'garage-s3-cold' ||
      body.coldStorageEndpoint === 's3-glacier-compatible' ||
      body.coldStorageEndpoint === 'nas-cold-archive'
        ? body.coldStorageEndpoint
        : fallback.coldStorageEndpoint,
    lakehouseFormat:
      body.lakehouseFormat === 'duckdb-parquet-compacted' ||
      body.lakehouseFormat === 'hive-parquet-append'
        ? body.lakehouseFormat
        : fallback.lakehouseFormat,
    compactionSchedule:
      body.compactionSchedule === 'hourly' ||
      body.compactionSchedule === 'daily-01utc' ||
      body.compactionSchedule === 'weekly-sun'
        ? body.compactionSchedule
        : fallback.compactionSchedule,
    ingestTransport:
      body.ingestTransport === 'local-segments' || body.ingestTransport === 'http-batch-ingest'
        ? body.ingestTransport
        : fallback.ingestTransport,
    customMachineTopology:
      typeof body.customMachineTopology === 'string'
        ? body.customMachineTopology.slice(0, 2000)
        : fallback.customMachineTopology,
    ignoredErrorCodes:
      typeof body.ignoredErrorCodes === 'string'
        ? body.ignoredErrorCodes.slice(0, 1000)
        : fallback.ignoredErrorCodes,
  };
}

export const WHITE_LABEL_EDITORIAL_CSS = `
  :root {
    --scalar-font: "DM Sans", "Plus Jakarta Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    --scalar-font-code: "JetBrains Mono", "Fira Code", ui-monospace, SFMono-Regular, monospace;
    --scalar-color-1: #101b26;
    --scalar-color-2: #475569;
    --scalar-color-3: #64748b;
    --scalar-color-accent: #16324f;
    --scalar-background-1: #ffffff;
    --scalar-background-2: #f8f9fa;
    --scalar-background-3: #f1f3f5;
    --scalar-border-color: #e5e7eb;
    --scalar-sidebar-background-1: #f8f9fa;
    --scalar-sidebar-color-1: #101b26;
    --scalar-sidebar-color-2: #475569;
    --scalar-sidebar-border-color: #e5e7eb;
    --scalar-radius: 2px;
    --scalar-radius-lg: 2px;
    --scalar-radius-xl: 2px;
  }
  body {
    background: #f4f5f6 !important;
    font-family: var(--scalar-font) !important;
    padding-top: 48px !important;
  }
  /* Industrial Executive Top Bar — Midnight Steel & Brushed Brass */
  .erp-scalar-topbar {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    height: 48px;
    z-index: 9999;
    background: #0b1622;
    border-bottom: 2px solid #c9a45c;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 20px;
    font-family: "Plus Jakarta Sans", "DM Sans", -apple-system, sans-serif;
    color: #ffffff;
    box-sizing: border-box;
  }
  .erp-scalar-topbar-left {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }
  .erp-scalar-topbar-brand {
    font-size: 13px;
    font-weight: 700;
    letter-spacing: -0.01em;
    color: #ffffff;
    white-space: nowrap;
  }
  .erp-scalar-topbar-sep {
    color: #4b6178;
    font-size: 12px;
  }
  .erp-scalar-topbar-sub {
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 11px;
    color: #c9a45c;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .erp-scalar-topbar-right {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-shrink: 0;
  }
  .erp-scalar-lang-group {
    display: inline-flex;
    align-items: center;
    border: 1px solid #1a2c3f;
    background: #122334;
    border-radius: 2px;
    padding: 2px;
    gap: 2px;
  }
  .erp-scalar-lang-btn {
    padding: 3px 8px;
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    text-decoration: none;
    border-radius: 1px;
    color: #cbd5e1;
    transition: background 0.15s ease, color 0.15s ease;
  }
  .erp-scalar-lang-btn:hover {
    color: #ffffff;
  }
  .erp-scalar-lang-btn.is-active {
    background: #c9a45c;
    color: #0b1622;
  }
  .erp-scalar-back {
    display: inline-flex;
    align-items: center;
    padding: 5px 11px;
    font-size: 11.5px;
    font-weight: 600;
    color: #e2e8f0;
    background: #122334;
    border: 1px solid #1a2c3f;
    border-radius: 2px;
    text-decoration: none;
    white-space: nowrap;
  }
  .erp-scalar-back:hover {
    background: #162b41;
    color: #ffffff;
  }

  /* Restrained squared editorial borders on cards, tables, and code objects */
  .scalar-api-reference header,
  .scalar-api-reference .introduction-card,
  .scalar-api-reference .scalar-card,
  .scalar-api-reference .endpoint-card,
  .scalar-api-reference table,
  .scalar-api-reference pre,
  .scalar-api-reference code {
    border-radius: 2px !important;
    border-color: #e5e7eb !important;
    box-shadow: none !important;
  }
  .scalar-api-reference table {
    border-collapse: collapse !important;
    border: 0 !important;
    border-radius: 0 !important;
  }
  .scalar-api-reference table th,
  .scalar-api-reference table td {
    border-left: 0 !important;
    border-right: 0 !important;
  }
  .scalar-api-reference table th {
    background: #f8f9fa !important;
    border-top: 1px solid #e6ebf1 !important;
    border-bottom: 1px solid #e6ebf1 !important;
    font-size: 11px !important;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #64748b !important;
  }
  .scalar-api-reference table td {
    border-top: 0 !important;
    border-bottom: 1px solid #e6ebf1 !important;
  }
  .scalar-api-reference table tbody tr:last-child td {
    border-bottom: 0 !important;
  }
  .scalar-api-reference .section-header-wrapper h1,
  .scalar-api-reference h1,
  .scalar-api-reference h2 {
    letter-spacing: -0.02em;
    font-weight: 650;
    color: #0d1b2a;
  }
  .sidebar-heading-link,
  .sidebar-group-item {
    font-size: 13px;
  }
  .open-api-client-button,
  a[href*="scalar.com"],
  .powered-by-scalar,
  [data-testid="powered-by"] {
    display: none !important;
  }

  /* Scalar API Key / Sandbox Auth Trigger & Modal (Midnight Steel & Brushed Brass) */
  .erp-scalar-auth-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 11px;
    font-size: 11.5px;
    font-weight: 600;
    color: #0b1622;
    background: #c9a45c;
    border: 1px solid #c9a45c;
    border-radius: 2px;
    cursor: pointer;
    white-space: nowrap;
    transition: background 0.15s ease;
  }
  .erp-scalar-auth-btn:hover {
    background: #d8b56d;
  }
  .erp-scalar-auth-btn.is-ready {
    background: #0f6b54;
    border-color: #0f6b54;
    color: #ffffff;
  }
  .erp-scalar-modal-backdrop {
    display: none;
    position: fixed;
    inset: 0;
    z-index: 10000;
    background: rgba(11, 22, 34, 0.62);
    align-items: center;
    justify-content: center;
    padding: 16px;
    font-family: "DM Sans", -apple-system, sans-serif;
  }
  .erp-scalar-modal-backdrop.is-open {
    display: flex;
  }
  .erp-scalar-modal {
    width: 100%;
    max-width: 520px;
    background: #ffffff;
    border: 1px solid #cbd2da;
    border-top: 3px solid #c9a45c;
    border-radius: 2px;
    color: #101b26;
    overflow: hidden;
  }
  .erp-scalar-modal-hd {
    padding: 14px 18px;
    border-bottom: 1px solid #e5e7eb;
    background: #f8f9fa;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .erp-scalar-modal-title {
    font-family: "Plus Jakarta Sans", sans-serif;
    font-size: 14px;
    font-weight: 700;
    color: #101b26;
    margin: 0;
  }
  .erp-scalar-modal-close {
    background: transparent;
    border: 1px solid #cbd2da;
    border-radius: 2px;
    color: #475569;
    font-size: 11px;
    font-weight: 600;
    padding: 3px 8px;
    cursor: pointer;
  }
  .erp-scalar-modal-bd {
    padding: 16px 18px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    font-size: 12px;
  }
  .erp-scalar-section-lbl {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #475569;
    margin-bottom: 6px;
  }
  .erp-scalar-role-row {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
  }
  .erp-scalar-role-btn {
    padding: 7px 10px;
    border: 1px solid #cbd2da;
    background: #ffffff;
    border-radius: 2px;
    font-size: 11.5px;
    font-weight: 600;
    color: #16324f;
    cursor: pointer;
    text-align: center;
  }
  .erp-scalar-role-btn:hover {
    background: #eef3f7;
    border-color: #16324f;
  }
  .erp-scalar-input-row {
    display: flex;
    gap: 8px;
  }
  .erp-scalar-input {
    flex: 1;
    padding: 7px 10px;
    border: 1px solid #cbd2da;
    border-radius: 2px;
    font-family: "JetBrains Mono", monospace;
    font-size: 11.5px;
    color: #101b26;
    background: #ffffff;
  }
  .erp-scalar-primary-btn {
    padding: 7px 12px;
    background: #16324f;
    color: #ffffff;
    border: 1px solid #16324f;
    border-radius: 2px;
    font-size: 11.5px;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
  }
  .erp-scalar-primary-btn:hover {
    background: #0f243b;
  }
  .erp-scalar-result {
    padding: 10px 12px;
    background: #f8f9fa;
    border: 1px solid #e5e7eb;
    border-radius: 2px;
    display: none;
    flex-direction: column;
    gap: 6px;
  }
  .erp-scalar-result.is-visible {
    display: flex;
  }
  .erp-scalar-code {
    font-family: "JetBrains Mono", monospace;
    font-size: 11px;
    background: #0b1622;
    color: #c9a45c;
    padding: 7px 9px;
    border-radius: 2px;
    word-break: break-all;
  }
  .erp-scalar-msg {
    font-size: 11.5px;
    color: #475569;
  }
  .erp-scalar-msg.is-err {
    color: #b4232c;
    font-weight: 600;
  }
  .erp-scalar-msg.is-ok {
    color: #0f6b54;
    font-weight: 600;
  }
`;

function escapeHtmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function buildScalarTopBarHtml(options: {
  lang: 'en' | 'it';
  brand: string;
  subtitle: string;
  backToConsole: string;
  docsBasePath: string;
  authEnforced?: boolean;
}): string {
  const { lang, brand, subtitle, backToConsole, docsBasePath, authEnforced = false } = options;
  const safeBasePath = docsBasePath.startsWith('/') ? docsBasePath : `/${docsBasePath}`;
  const enHref = escapeHtmlText(`${safeBasePath}?lang=en`);
  const itHref = escapeHtmlText(`${safeBasePath}?lang=it`);
  const safeBrand = escapeHtmlText(brand);
  const safeSubtitle = escapeHtmlText(subtitle);
  const safeBackToConsole = escapeHtmlText(backToConsole);
  const isIt = lang === 'it';

  const copy = isIt
    ? {
        triggerBtn: 'Chiave API / Test',
        triggerReady: 'X-API-Key Pronta',
        modalTitle: 'Autenticazione API & Chiave Test (X-API-Key)',
        close: 'Chiudi',
        quickTitle: '1. Stacca Chiave Test 1h per Ruolo (Audit & Log Attivi)',
        quickHint:
          'Genera una chiave temporanea X-API-Key (pat_live_...) salvata con hash SHA-256 cifrato AES-256-GCM e tracciata in Audit Log.',
        credTitle: '2. Oppure Autenticati con Account Impianto (Modalità Strict)',
        emailPh: 'Email aziendale (es. admin@plant.local)',
        passPh: 'Password account',
        issueCredBtn: 'Stacca Chiave 1h',
        verifyTitle: '3. Verifica una Chiave API Emessa dall’Admin (X-API-Key)',
        verifyPh: 'Incolla pat_live_... per verificare scope e scadenza',
        verifyBtn: 'Verifica',
        copyKey: 'Copia X-API-Key',
        copied: 'Copiata!',
        hintScalar:
          'Incolla la chiave nel campo Authentication → ApiKeyHeaderAuth (X-API-Key) di Scalar per testare tutti gli endpoint.',
      }
    : {
        triggerBtn: 'API Key / Test Auth',
        triggerReady: 'X-API-Key Ready',
        modalTitle: 'API Authentication & Sandbox Key (X-API-Key)',
        close: 'Close',
        quickTitle: '1. Issue 1h Test Key by Role (Audited & Logged)',
        quickHint:
          'Mints a 1-hour X-API-Key (pat_live_...) stored as an AES-256-GCM encrypted SHA-256 hash and recorded in the Audit Log.',
        credTitle: '2. Or Sign In with Plant Account (Strict Production Mode)',
        emailPh: 'Work email (e.g. admin@plant.local)',
        passPh: 'Account password',
        issueCredBtn: 'Mint 1h Key',
        verifyTitle: '3. Verify an Admin-Issued API Key (X-API-Key)',
        verifyPh: 'Paste pat_live_... to verify scopes and expiry',
        verifyBtn: 'Verify',
        copyKey: 'Copy X-API-Key',
        copied: 'Copied!',
        hintScalar:
          'Paste the key into Scalar Authentication → ApiKeyHeaderAuth (X-API-Key) to execute live API requests.',
      };

  const quickRoleSection = !authEnforced
    ? `
    <div>
      <div class="erp-scalar-section-lbl">${copy.quickTitle}</div>
      <div class="erp-scalar-msg" style="margin-bottom:8px;">${copy.quickHint}</div>
      <div class="erp-scalar-role-row">
        <button type="button" class="erp-scalar-role-btn" data-sandbox-role="admin">Admin (full)</button>
        <button type="button" class="erp-scalar-role-btn" data-sandbox-role="operator">Operator (read+edge)</button>
        <button type="button" class="erp-scalar-role-btn" data-sandbox-role="viewer">Viewer (read)</button>
      </div>
    </div>`
    : '';

  return `
<div class="erp-scalar-topbar" role="banner">
  <div class="erp-scalar-topbar-left">
    <span class="erp-scalar-topbar-brand">${safeBrand}</span>
    <span class="erp-scalar-topbar-sep">/</span>
    <span class="erp-scalar-topbar-sub">${safeSubtitle}</span>
  </div>
  <div class="erp-scalar-topbar-right">
    <button type="button" id="erp-scalar-auth-trigger" class="erp-scalar-auth-btn">${copy.triggerBtn}</button>
    <div class="erp-scalar-lang-group" role="group" aria-label="Language">
      <a href="${enHref}" class="erp-scalar-lang-btn ${lang === 'en' ? 'is-active' : ''}" onclick="document.cookie='telemetry_erp_lang=en; path=/; max-age=31536000; SameSite=Lax'">EN</a>
      <a href="${itHref}" class="erp-scalar-lang-btn ${lang === 'it' ? 'is-active' : ''}" onclick="document.cookie='telemetry_erp_lang=it; path=/; max-age=31536000; SameSite=Lax'">IT</a>
    </div>
    <a href="/?lang=${lang}" class="erp-scalar-back">${safeBackToConsole}</a>
  </div>
</div>

<div id="erp-scalar-auth-modal" class="erp-scalar-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="erp-scalar-modal-title">
  <div class="erp-scalar-modal">
    <div class="erp-scalar-modal-hd">
      <h2 id="erp-scalar-modal-title" class="erp-scalar-modal-title">${copy.modalTitle}</h2>
      <button type="button" id="erp-scalar-modal-close" class="erp-scalar-modal-close">${copy.close}</button>
    </div>
    <div class="erp-scalar-modal-bd">
      ${quickRoleSection}

      <form id="erp-scalar-cred-form">
        <div class="erp-scalar-section-lbl">${copy.credTitle}</div>
        <div class="erp-scalar-input-row" style="margin-bottom:6px;">
          <input id="erp-scalar-email" type="email" class="erp-scalar-input" placeholder="${copy.emailPh}" autocomplete="username" required />
          <input id="erp-scalar-pass" type="password" class="erp-scalar-input" placeholder="${copy.passPh}" autocomplete="current-password" required />
        </div>
        <button type="submit" class="erp-scalar-primary-btn">${copy.issueCredBtn}</button>
      </form>

      <form id="erp-scalar-verify-form">
        <div class="erp-scalar-section-lbl">${copy.verifyTitle}</div>
        <div class="erp-scalar-input-row">
          <input id="erp-scalar-verify-input" type="password" class="erp-scalar-input" placeholder="${copy.verifyPh}" />
          <button type="submit" class="erp-scalar-primary-btn">${copy.verifyBtn}</button>
        </div>
      </form>

      <div id="erp-scalar-result" class="erp-scalar-result">
        <div id="erp-scalar-status" class="erp-scalar-msg"></div>
        <div id="erp-scalar-key-box" class="erp-scalar-code" style="display:none;"></div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
          <span class="erp-scalar-msg">${copy.hintScalar}</span>
          <button type="button" id="erp-scalar-copy-btn" class="erp-scalar-primary-btn" style="display:none;">${copy.copyKey}</button>
        </div>
      </div>
    </div>
  </div>
</div>

<script>
(function () {
  var trigger = document.getElementById('erp-scalar-auth-trigger');
  var modal = document.getElementById('erp-scalar-auth-modal');
  var closeBtn = document.getElementById('erp-scalar-modal-close');
  var resultBox = document.getElementById('erp-scalar-result');
  var statusEl = document.getElementById('erp-scalar-status');
  var keyBox = document.getElementById('erp-scalar-key-box');
  var copyBtn = document.getElementById('erp-scalar-copy-btn');
  var credForm = document.getElementById('erp-scalar-cred-form');
  var verifyForm = document.getElementById('erp-scalar-verify-form');
  var verifyInput = document.getElementById('erp-scalar-verify-input');
  var activeKeyInMemory = '';

  function openModal() { if (modal) modal.classList.add('is-open'); }
  function closeModal() { if (modal) modal.classList.remove('is-open'); }

  function showStatus(msg, isErr, rawKey) {
    if (!resultBox || !statusEl || !keyBox || !copyBtn) return;
    resultBox.classList.add('is-visible');
    statusEl.textContent = msg;
    statusEl.className = 'erp-scalar-msg ' + (isErr ? 'is-err' : 'is-ok');
    if (rawKey) {
      activeKeyInMemory = rawKey;
      keyBox.textContent = rawKey;
      keyBox.style.display = 'block';
      copyBtn.style.display = 'inline-block';
      if (trigger) {
        trigger.textContent = ${JSON.stringify(copy.triggerReady)};
        trigger.classList.add('is-ready');
      }
    } else if (isErr) {
      keyBox.style.display = 'none';
      copyBtn.style.display = 'none';
    }
  }

  async function mintSandbox(payload) {
    try {
      var res = await fetch('/api/v1/tokens/sandbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      var data = await res.json();
      if (!res.ok || !data.token) {
        showStatus(data.error || ('HTTP ' + res.status), true);
        return;
      }
      var rec = data.record || {};
      var scopes = Array.isArray(rec.scopes) ? rec.scopes.join(', ') : '';
      showStatus('OK · ' + (rec.name || 'Sandbox') + ' · scopes: [' + scopes + '] · exp: ' + (rec.expiresAt || '1h'), false, data.token);
    } catch (e) {
      showStatus(String(e && e.message ? e.message : e), true);
    }
  }

  async function verifyKey(candidate) {
    if (!candidate) return;
    try {
      var res = await fetch('/api/v1/auth/whoami', {
        headers: { 'X-API-Key': candidate }
      });
      var data = await res.json();
      if (!res.ok || !data.authenticated) {
        showStatus(data.error || ('Rejected (HTTP ' + res.status + ')'), true);
        return;
      }
      var scopes = Array.isArray(data.allowedScopes) ? data.allowedScopes.join(', ') : '';
      var tokName = data.token && data.token.name ? data.token.name : (data.user && data.user.email ? data.user.email : data.credentialType);
      showStatus('VERIFIED · ' + tokName + ' · scopes: [' + scopes + ']', false, candidate);
    } catch (e) {
      showStatus(String(e && e.message ? e.message : e), true);
    }
  }

  if (trigger) trigger.addEventListener('click', openModal);
  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  if (modal) modal.addEventListener('click', function (ev) { if (ev.target === modal) closeModal(); });

  document.querySelectorAll('[data-sandbox-role]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var role = btn.getAttribute('data-sandbox-role');
      mintSandbox({ role: role });
    });
  });

  if (credForm) {
    credForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var emailEl = document.getElementById('erp-scalar-email');
      var passEl = document.getElementById('erp-scalar-pass');
      mintSandbox({
        email: emailEl ? emailEl.value : '',
        password: passEl ? passEl.value : ''
      });
      if (passEl) passEl.value = '';
    });
  }

  if (verifyForm) {
    verifyForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      verifyKey(verifyInput ? verifyInput.value.trim() : '');
    });
  }

  if (copyBtn) {
    copyBtn.addEventListener('click', function () {
      if (!activeKeyInMemory) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(activeKeyInMemory).then(function () {
          copyBtn.textContent = ${JSON.stringify(copy.copied)};
          setTimeout(function () { copyBtn.textContent = ${JSON.stringify(copy.copyKey)}; }, 1600);
        });
      }
    });
  }

  // Handle secure hash handoff from Admin Console ("Test in Scalar") and strip fragment immediately
  if (window.location.hash && window.location.hash.indexOf('token=') !== -1) {
    var m = window.location.hash.match(/token=([^&]+)/);
    if (m && m[1]) {
      var handedOff = decodeURIComponent(m[1]);
      try {
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      } catch (_e) {}
      openModal();
      verifyKey(handedOff);
    }
  }
})();
</script>`;
}

