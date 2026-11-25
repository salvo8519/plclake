/**
 * CI Quality Gate: Validates bilingual i18n parity, placeholder integrity,
 * OpenAPI route translation coverage, 1:1 EN/IT Zensical documentation mirror,
 * relative markdown link integrity, and code-derived README badge alignment.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateOpenApiSpec } from '../src/apiSchemas.ts';
import { APP_META } from '../src/config/appMeta.ts';
import {
  buildBadgesBlock,
  collectCodeMetrics,
  extractBadgesSection,
} from './sync-readme-badges.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const errors: string[] = [];

function fail(scope: string, message: string) {
  errors.push(`[${scope}] ${message}`);
}

function flattenJson(
  obj: unknown,
  prefix = '',
  out: Map<string, string | string[]> = new Map()
): Map<string, string | string[]> {
  if (typeof obj === 'string') {
    out.set(prefix, obj);
    return out;
  }
  if (Array.isArray(obj)) {
    out.set(prefix, obj.map((item) => String(item)));
    return out;
  }
  if (obj && typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj)) {
      const next = prefix ? `${prefix}.${key}` : key;
      flattenJson(value, next, out);
    }
  }
  return out;
}

function extractPlaceholders(value: string | string[]): string[] {
  const text = Array.isArray(value) ? value.join('\n') : value;
  const matches = text.match(/\{\{\s*[a-zA-Z0-9_]+\s*\}\}/g) ?? [];
  return Array.from(new Set(matches.map((m) => m.replace(/\s+/g, '')))).sort();
}

function walkRelativeMarkdown(baseDir: string, currentDir = baseDir): string[] {
  if (!fs.existsSync(currentDir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    const full = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkRelativeMarkdown(baseDir, full));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(path.relative(baseDir, full).replace(/\\/g, '/'));
    }
  }
  return results.sort();
}

function checkLocales() {
  const enDir = path.join(ROOT_DIR, 'src/i18n/locales/en');
  const itDir = path.join(ROOT_DIR, 'src/i18n/locales/it');

  if (!fs.existsSync(enDir) || !fs.existsSync(itDir)) {
    fail('i18n', 'Missing src/i18n/locales/en or src/i18n/locales/it directory.');
    return;
  }

  const enFiles = fs.readdirSync(enDir).filter((f) => f.endsWith('.json')).sort();
  const itFiles = fs.readdirSync(itDir).filter((f) => f.endsWith('.json')).sort();

  for (const f of enFiles) {
    if (!itFiles.includes(f)) fail('i18n:namespace', `Missing Italian namespace file: it/${f}`);
  }
  for (const f of itFiles) {
    if (!enFiles.includes(f)) fail('i18n:namespace', `Missing English namespace file: en/${f}`);
  }

  const shared = enFiles.filter((f) => itFiles.includes(f));
  for (const file of shared) {
    const enJson = JSON.parse(fs.readFileSync(path.join(enDir, file), 'utf-8'));
    const itJson = JSON.parse(fs.readFileSync(path.join(itDir, file), 'utf-8'));

    const enMap = flattenJson(enJson);
    const itMap = flattenJson(itJson);

    for (const [key, enVal] of enMap.entries()) {
      if (!itMap.has(key)) {
        fail('i18n:keys', `Missing Italian translation for ${file} -> "${key}"`);
        continue;
      }
      const itVal = itMap.get(key)!;
      if (typeof enVal === 'string' && enVal.trim().length === 0) {
        fail('i18n:empty', `Empty English translation for ${file} -> "${key}"`);
      }
      if (typeof itVal === 'string' && itVal.trim().length === 0) {
        fail('i18n:empty', `Empty Italian translation for ${file} -> "${key}"`);
      }
      const enPh = extractPlaceholders(enVal);
      const itPh = extractPlaceholders(itVal);
      if (enPh.join(',') !== itPh.join(',')) {
        fail(
          'i18n:placeholders',
          `Mismatched placeholders in ${file} -> "${key}": EN=[${enPh.join(', ')}] vs IT=[${itPh.join(', ')}]`
        );
      }
    }

    for (const key of itMap.keys()) {
      if (!enMap.has(key)) {
        fail('i18n:keys', `Extra Italian translation not found in English: ${file} -> "${key}"`);
      }
    }
  }
}

function checkOpenApiTranslations() {
  const enOpenApi = JSON.parse(
    fs.readFileSync(path.join(ROOT_DIR, 'src/i18n/locales/en/openapi.json'), 'utf-8')
  ) as { operations?: Record<string, string> };
  const itOpenApi = JSON.parse(
    fs.readFileSync(path.join(ROOT_DIR, 'src/i18n/locales/it/openapi.json'), 'utf-8')
  ) as { operations?: Record<string, string> };

  const spec = generateOpenApiSpec(undefined, 'en') as {
    paths?: Record<string, Record<string, unknown>>;
  };

  const httpMethods = new Set(['get', 'post', 'put', 'patch', 'delete']);
  for (const [routePath, pathItem] of Object.entries(spec.paths ?? {})) {
    for (const method of Object.keys(pathItem ?? {})) {
      if (!httpMethods.has(method.toLowerCase())) continue;
      const opKey = `${method.toUpperCase()} ${routePath}`;
      if (!enOpenApi.operations?.[opKey]) {
        fail('openapi:i18n', `Missing EN operation summary in openapi.json for "${opKey}"`);
      }
      if (!itOpenApi.operations?.[opKey]) {
        fail('openapi:i18n', `Missing IT operation summary in openapi.json for "${opKey}"`);
      }
    }
  }
}

function checkOpenApiStaticDrift() {
  const apiDir = path.join(ROOT_DIR, 'docs/api');
  const expectedFiles: Array<{ file: string; lang: 'en' | 'it' }> = [
    { file: 'openapi.en.json', lang: 'en' },
    { file: 'openapi.it.json', lang: 'it' },
    { file: 'openapi.json', lang: 'en' },
  ];

  for (const { file, lang } of expectedFiles) {
    const fullPath = path.join(apiDir, file);
    if (!fs.existsSync(fullPath)) {
      fail('openapi:drift', `Missing static spec docs/api/${file}. Run "npm run docs:openapi".`);
      continue;
    }
    const expected = `${JSON.stringify(generateOpenApiSpec(undefined, lang), null, 2)}\n`;
    const actual = fs.readFileSync(fullPath, 'utf-8');
    if (actual !== expected) {
      fail(
        'openapi:drift',
        `Static spec docs/api/${file} is out of sync with src/apiSchemas.ts (Scalar live spec). Run "npm run docs:openapi".`
      );
    }
  }
}

function checkBilingualDocsAndNav() {
  const enDocsDir = path.join(ROOT_DIR, 'docs/en');
  const itDocsDir = path.join(ROOT_DIR, 'docs/it');

  const enPages = walkRelativeMarkdown(enDocsDir);
  const itPages = walkRelativeMarkdown(itDocsDir);

  if (enPages.length === 0) {
    fail('docs:mirror', 'No English documentation pages found in docs/en/.');
  }

  for (const page of enPages) {
    if (!itPages.includes(page)) fail('docs:mirror', `Missing Italian twin page: docs/it/${page}`);
  }
  for (const page of itPages) {
    if (!enPages.includes(page)) fail('docs:mirror', `Missing English twin page: docs/en/${page}`);
  }

  const zensicalPath = path.join(ROOT_DIR, 'zensical.toml');
  if (!fs.existsSync(zensicalPath)) {
    fail('docs:zensical', 'Missing zensical.toml at workspace root.');
    return;
  }

  const toml = fs.readFileSync(zensicalPath, 'utf-8');
  for (const match of toml.matchAll(/=\s*"([^"]+\.md)"/g)) {
    const relDocPath = match[1];
    const absPath = path.join(ROOT_DIR, 'docs', relDocPath);
    if (!fs.existsSync(absPath)) {
      fail('docs:zensical', `zensical.toml references non-existent doc: docs/${relDocPath}`);
    }
  }
}

function checkMarkdownLinks() {
  const mdFiles = [
    path.join(ROOT_DIR, 'README.md'),
    path.join(ROOT_DIR, 'README.it.md'),
    ...walkRelativeMarkdown(path.join(ROOT_DIR, 'docs')).map((rel) =>
      path.join(ROOT_DIR, 'docs', rel)
    ),
  ].filter((f) => fs.existsSync(f));

  const linkRegex = /(?:\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)|href="([^"]+)")/g;

  for (const filePath of mdFiles) {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const withoutCode = raw.replace(/```[\s\S]*?```/g, '');
    const fileDir = path.dirname(filePath);
    const relFile = path.relative(ROOT_DIR, filePath).replace(/\\/g, '/');

    for (const match of withoutCode.matchAll(linkRegex)) {
      const target = (match[1] ?? match[2] ?? '').trim();
      if (
        !target ||
        target.startsWith('http://') ||
        target.startsWith('https://') ||
        target.startsWith('mailto:') ||
        target.startsWith('#') ||
        target.startsWith('/api/')
      ) {
        continue;
      }

      const cleanTarget = target.split('#')[0].split('?')[0];
      if (!cleanTarget) continue;

      const resolved = path.resolve(fileDir, cleanTarget);
      if (!fs.existsSync(resolved)) {
        fail('docs:links', `Broken relative link in ${relFile} -> "${target}"`);
      }
    }
  }
}

function checkReadmeBadges() {
  const metrics = collectCodeMetrics();
  const readmes: Array<{ file: string; lang: 'en' | 'it' }> = [
    { file: 'README.md', lang: 'en' },
    { file: 'README.it.md', lang: 'it' },
  ];

  for (const { file, lang } of readmes) {
    const fullPath = path.join(ROOT_DIR, file);
    if (!fs.existsSync(fullPath)) {
      fail('readme', `Missing ${file} at workspace root.`);
      continue;
    }
    const content = fs.readFileSync(fullPath, 'utf-8');
    const actualBlock = extractBadgesSection(content);
    const expectedBlock = buildBadgesBlock(lang, metrics);
    if (!actualBlock) {
      fail('readme:badges', `${file} is missing <!-- BADGES:START --> ... <!-- BADGES:END --> markers.`);
    } else if (actualBlock.trim() !== expectedBlock.trim()) {
      fail(
        'readme:badges',
        `${file} badges are out of sync with package.json/code. Run "npm run sync:badges".`
      );
    }
  }
}

function checkCentralizedAppMeta() {
  const configPath = path.join(ROOT_DIR, 'config/app.json');
  if (!fs.existsSync(configPath)) {
    fail('meta:config', 'Missing centralized config/app.json.');
    return;
  }
  const pkgPath = path.join(ROOT_DIR, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
    name?: string;
    version?: string;
  };
  if (pkg.version !== APP_META.version) {
    fail(
      'meta:version',
      `package.json version (${pkg.version ?? 'missing'}) differs from config/app.json (${APP_META.version}). Run "npm run sync:badges".`
    );
  }
  if (pkg.name !== APP_META.slug) {
    fail(
      'meta:name',
      `package.json name (${pkg.name ?? 'missing'}) differs from config/app.json slug (${APP_META.slug}). Run "npm run sync:badges".`
    );
  }
  const chartPath = path.join(ROOT_DIR, 'deploy/helm/plclake/Chart.yaml');
  if (fs.existsSync(chartPath)) {
    const chartRaw = fs.readFileSync(chartPath, 'utf-8');
    const chartAppVer = chartRaw.match(/^appVersion:\s*"?([^"\n]+)"?$/m)?.[1]?.trim();
    if (chartAppVer !== APP_META.version) {
      fail(
        'meta:helm',
        `deploy/helm/plclake/Chart.yaml appVersion (${chartAppVer ?? 'missing'}) differs from config/app.json (${APP_META.version}). Run "npm run sync:badges".`
      );
    }
  }
}

function main() {
  checkCentralizedAppMeta();
  checkLocales();
  checkOpenApiTranslations();
  checkOpenApiStaticDrift();
  checkBilingualDocsAndNav();
  checkMarkdownLinks();
  checkReadmeBadges();

  if (errors.length > 0) {
    console.error(`\n[check:i18n] FAILED with ${errors.length} issue(s):\n`);
    for (const err of errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }

  const metrics = collectCodeMetrics();
  console.log(
    `[check:i18n] PASSED — 100% EN/IT parity (${metrics.i18nKeyCount} keys, ${metrics.endpointCount} OpenAPI routes, static Scalar specs in sync, ${metrics.bilingualDocPages}×2 doc pages, links & README badges verified).`
  );
}

main();
