/**
 * Syncs code-derived Finance Navy (#0B1F3A) & Gold (#C88A1E) badges
 * into README.md (EN) and README.it.md (IT) between
 * <!-- BADGES:START --> and <!-- BADGES:END --> markers.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateOpenApiSpec } from '../src/apiSchemas.ts';
import { APP_META } from '../src/config/appMeta.ts';
import type { SupportedLanguage } from '../src/i18n/types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const BADGES_START = '<!-- BADGES:START -->';
const BADGES_END = '<!-- BADGES:END -->';

const NAVY = '0B1622';
const NAVY_MID = '16324F';
const GOLD = 'C9A45C';
const EMERALD = '0F6B54';

export interface CodeMetrics {
  appVersion: string;
  reactVersion: string;
  typescriptVersion: string;
  expressVersion: string;
  i18nextVersion: string;
  openapiVersion: string;
  endpointCount: number;
  i18nKeyCount: number;
  bilingualDocPages: number;
  hasCiWorkflow: boolean;
  hasDocsWorkflow: boolean;
}

function cleanSemver(range?: string): string {
  if (!range) return 'n/a';
  return range.replace(/^[\^~>=<\s]+/, '');
}

function countLeafStrings(obj: unknown): number {
  if (typeof obj === 'string') return 1;
  if (Array.isArray(obj)) return 1;
  if (obj && typeof obj === 'object') {
    return Object.values(obj).reduce((sum, val) => sum + countLeafStrings(val), 0);
  }
  return 0;
}

function walkMarkdownFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkMarkdownFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(full);
    }
  }
  return results;
}

export function collectCodeMetrics(): CodeMetrics {
  const pkgPath = path.join(ROOT_DIR, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
    version?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  const deps = { ...(pkg.devDependencies ?? {}), ...(pkg.dependencies ?? {}) };
  const spec = generateOpenApiSpec(undefined, 'en') as {
    openapi?: string;
    paths?: Record<string, Record<string, unknown>>;
  };

  const httpMethods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
  let endpointCount = 0;
  for (const pathItem of Object.values(spec.paths ?? {})) {
    for (const method of Object.keys(pathItem ?? {})) {
      if (httpMethods.has(method.toLowerCase())) endpointCount += 1;
    }
  }

  const enLocaleDir = path.join(ROOT_DIR, 'src/i18n/locales/en');
  let i18nKeyCount = 0;
  if (fs.existsSync(enLocaleDir)) {
    for (const file of fs.readdirSync(enLocaleDir).filter((f) => f.endsWith('.json'))) {
      const json = JSON.parse(fs.readFileSync(path.join(enLocaleDir, file), 'utf-8'));
      i18nKeyCount += countLeafStrings(json);
    }
  }

  const bilingualDocPages = walkMarkdownFiles(path.join(ROOT_DIR, 'docs/en')).length;
  const hasCiWorkflow = fs.existsSync(path.join(ROOT_DIR, '.github/workflows/ci.yml'));
  const hasDocsWorkflow = fs.existsSync(path.join(ROOT_DIR, '.github/workflows/docs.yml'));

  return {
    appVersion: APP_META.version,
    reactVersion: cleanSemver(deps.react),
    typescriptVersion: cleanSemver(deps.typescript),
    expressVersion: cleanSemver(deps.express),
    i18nextVersion: cleanSemver(deps.i18next),
    openapiVersion: spec.openapi ?? '3.1.0',
    endpointCount,
    i18nKeyCount,
    bilingualDocPages,
    hasCiWorkflow,
    hasDocsWorkflow,
  };
}

function encodeShieldSegment(value: string): string {
  return encodeURIComponent(value.replace(/-/g, '--').replace(/_/g, '__'));
}

function makeBadge(label: string, message: string, color: string, logo?: string): string {
  const pathPart = `${encodeShieldSegment(label)}-${encodeShieldSegment(message)}-${color}`;
  const params = new URLSearchParams({
    style: 'flat-square',
    labelColor: NAVY,
  });
  if (logo) {
    params.set('logo', logo);
    params.set('logoColor', 'FFFFFF');
  }
  return `https://img.shields.io/badge/${pathPart}?${params.toString()}`;
}

function makeBadgeImg(alt: string, label: string, message: string, color: string, logo?: string): string {
  const url = makeBadge(label, message, color, logo);
  return `<img src="${url}" alt="${alt}" />`;
}

export function buildBadgesBlock(lang: SupportedLanguage, metrics: CodeMetrics = collectCodeMetrics()): string {
  const isIt = lang === 'it';

  const row1 = [
    makeBadgeImg('Release', isIt ? 'Versione' : 'Release', `v${metrics.appVersion}`, GOLD),
    makeBadgeImg('OpenAPI', 'OpenAPI', `${metrics.openapiVersion} · ${metrics.endpointCount} endpoints`, NAVY_MID, 'openapiinitiative'),
    makeBadgeImg('i18n', 'i18n', `EN | IT · ${metrics.i18nKeyCount} ${isIt ? 'chiavi' : 'keys'}`, GOLD, 'i18next'),
    makeBadgeImg('Docs', isIt ? 'Docs Zensical' : 'Zensical Docs', `${metrics.bilingualDocPages}×2 ${isIt ? 'pagine EN/IT' : 'EN/IT pages'}`, NAVY_MID),
    makeBadgeImg('CI Gate', isIt ? 'Gate CI' : 'CI Gate', metrics.hasCiWorkflow && metrics.hasDocsWorkflow ? 'ESLint · Biome · Ruff · Vitest' : 'Local', EMERALD, 'githubactions'),
  ];

  const row2 = [
    makeBadgeImg('React', 'React', metrics.reactVersion, NAVY_MID, 'react'),
    makeBadgeImg('TypeScript', 'TypeScript', metrics.typescriptVersion, NAVY_MID, 'typescript'),
    makeBadgeImg('Express', 'Express', metrics.expressVersion, NAVY_MID, 'express'),
    makeBadgeImg('i18next', 'i18next', metrics.i18nextVersion, GOLD),
    makeBadgeImg('Security', isIt ? 'Sicurezza' : 'Security', 'RBAC · AES-256-GCM · scrypt', EMERALD),
  ];

  return [
    BADGES_START,
    '<p align="center">',
    ...row1.map((b) => `  ${b}`),
    '  <br />',
    ...row2.map((b) => `  ${b}`),
    '</p>',
    BADGES_END,
  ].join('\n');
}

export function replaceBadgesSection(content: string, newBlock: string): string {
  const startIdx = content.indexOf(BADGES_START);
  const endIdx = content.indexOf(BADGES_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(`Missing ${BADGES_START} ... ${BADGES_END} markers.`);
  }
  return `${content.slice(0, startIdx)}${newBlock}${content.slice(endIdx + BADGES_END.length)}`;
}

export function extractBadgesSection(content: string): string | null {
  const startIdx = content.indexOf(BADGES_START);
  const endIdx = content.indexOf(BADGES_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return null;
  return content.slice(startIdx, endIdx + BADGES_END.length);
}

function syncPackageJsonMeta() {
  const pkgPath = path.join(ROOT_DIR, 'package.json');
  const pkgRaw = fs.readFileSync(pkgPath, 'utf-8');
  const pkg = JSON.parse(pkgRaw) as { name?: string; version?: string };
  if (pkg.version !== APP_META.version || pkg.name !== APP_META.slug) {
    pkg.name = APP_META.slug;
    pkg.version = APP_META.version;
    fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf-8');
    console.log(`[sync:badges] Synced package.json -> ${APP_META.slug}@${APP_META.version}`);
  }
}

function syncHelmChartVersion() {
  const chartPath = path.join(ROOT_DIR, 'deploy/helm/plclake/Chart.yaml');
  if (!fs.existsSync(chartPath)) return;
  const original = fs.readFileSync(chartPath, 'utf-8');
  const updated = original
    .replace(/^version:\s*.+$/m, `version: ${APP_META.version}`)
    .replace(/^appVersion:\s*.+$/m, `appVersion: "${APP_META.version}"`);
  if (updated !== original) {
    fs.writeFileSync(chartPath, updated, 'utf-8');
    console.log(`[sync:badges] Synced deploy/helm/plclake/Chart.yaml -> ${APP_META.version}`);
  }
}

function main() {
  syncPackageJsonMeta();
  syncHelmChartVersion();
  const metrics = collectCodeMetrics();
  const targets: Array<{ file: string; lang: SupportedLanguage }> = [
    { file: path.join(ROOT_DIR, 'README.md'), lang: 'en' },
    { file: path.join(ROOT_DIR, 'README.it.md'), lang: 'it' },
  ];

  for (const target of targets) {
    if (!fs.existsSync(target.file)) {
      throw new Error(`Target README not found: ${target.file}`);
    }
    const original = fs.readFileSync(target.file, 'utf-8');
    const updated = replaceBadgesSection(original, buildBadgesBlock(target.lang, metrics));
    fs.writeFileSync(target.file, updated, 'utf-8');
    console.log(`[sync:badges] Updated ${path.basename(target.file)} (${target.lang.toUpperCase()})`);
  }

  console.log(
    `[sync:badges] Metrics -> ${APP_META.name} v${metrics.appVersion}, ${metrics.endpointCount} OpenAPI endpoints, ${metrics.i18nKeyCount} i18n keys, ${metrics.bilingualDocPages}×2 docs pages.`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main();
}
