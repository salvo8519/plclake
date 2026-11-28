<div class="erp-docs-lang-bar">
  <span>Language:</span>
  <strong>EN</strong>
  <span>·</span>
  <a href="../../it/guides/i18n-and-docs-governance.md">IT (Italiano)</a>
</div>

# i18n, CI & Solo-Maintainer Automation Governance

This platform is engineered for **zero-drift, low-overhead maintenance** (including solo-maintainer workflows on GitLab or GitHub): code formatting, linting, TypeScript type checking, Python Edge Gateway checks, OpenAPI/Scalar static exports, bilingual EN/IT documentation parity, and dependency hygiene are all automated via **pre-commit hooks**, **CI gates**, and **Renovate**.

---

## Daily Maintenance Commands

```bash
npm run hooks:install  # One-time setup: activate Husky (.husky/pre-commit) + lint-staged locally
npm run lint:eslint    # ESLint (Airbnb style guide + React/Hooks/a11y/TS) on frontend & backend
npm run lint:code      # Biome linter (frontend + backend); any warning fails the gate
npm run lint:fix       # Auto-fix lint issues (Biome lint + ESLint); ESLint is the TS/TSX style authority
npm run lint           # TypeScript strict typecheck (tsc --noEmit)
npm run docs:openapi   # Regenerate docs/api/openapi.{en,it,}.json from Zod + i18n
npm run sync:badges    # Sync Midnight Steel & Brushed Brass README badges from code
npm run check:i18n     # CI Gate: EN/IT parity, OpenAPI/Scalar drift, docs mirror, links & badges
npm run verify         # Full solo-maintainer gate: TypeCheck + ESLint + Biome + i18n/OpenAPI + Vitest + Vite build
```

For the Python Edge Gateway (`project_repo/machine-logs-ml-pipeline/`):

```bash
pip install --require-hashes -r project_repo/machine-logs-ml-pipeline/src/requirements-lock.txt
ruff check project_repo/
ruff format --check project_repo/
pip-audit --require-hashes --disable-pip -r project_repo/machine-logs-ml-pipeline/src/requirements-lock.txt
PYTHONPATH=project_repo/machine-logs-ml-pipeline/src pytest project_repo/machine-logs-ml-pipeline/tests
```

---

## Automated CI Checks (`npm run check:i18n`)

| Check | Invariant Verified |
| :--- | :--- |
| **1. Namespace Parity** | Identical JSON namespaces across `src/i18n/locales/en/` and `src/i18n/locales/it/`. |
| **2. Recursive Key Parity** | Every key in `en` exists in `it` (and vice versa) with non-empty values. |
| **3. Placeholder Integrity** | All `{{variable}}` interpolation tokens match across `en` and `it`. |
| **4. OpenAPI Route Coverage** | Every route registered in `src/apiSchemas.ts` has localized EN and IT summaries. |
| **5. Static OpenAPI / Scalar Drift** | `docs/api/openapi.json`, `openapi.en.json`, and `openapi.it.json` match live Zod schemas byte-for-byte. |
| **6. Bilingual Docs 1:1 Mirror** | Every page in `docs/en/` has a twin in `docs/it/` and all `zensical.toml` targets exist. |
| **7. Relative Link Integrity** | All relative links across `docs/**/*.md`, `README.md`, and `README.it.md` resolve on disk. |
| **8. Code-Derived Badge Sync** | `README.md` and `README.it.md` badge blocks match live `package.json` and codebase metrics. |

---

## GitLab CI, Pre-Commit & Automated Dependency Hygiene

- **Git Pre-Commit Hook (`.husky/pre-commit` + `lint-staged`)**: Automatically runs **Biome lint** and **ESLint (Airbnb style guide)** on staged TypeScript/React files (the Biome formatter is disabled for TS/TSX, so the hook never reformats code ESLint owns), Biome on JSON/CSS, **Ruff** on staged Python files in `project_repo/`, TypeScript `tsc --noEmit`, and `npm run check:i18n` before every commit.
- **GitHub Actions & GitLab CI**: Both pipelines install from the committed lockfiles (`npm ci`, hash-verified Python lock) and cover ESLint (Airbnb), Biome, Ruff, `tsc`, EN/IT & OpenAPI drift check, `npm audit`, `pip-audit`, Vitest, Pytest, Vite production build, and the Zensical static site. GitHub Actions run with read-only `contents` permissions.
- **Route Table Snapshot**: `tests/route_table.test.ts` pins every route and its middleware chain (`requireScope(...)`, rate limits), so a route that loses its protection fails CI until reviewed.
- **Automated Dependency Updates (`renovate.json`)**: Weekly grouped non-major updates (low noise for a solo maintainer), weekly lockfile maintenance, plus immediate security vulnerability MRs for npm, Python, and Docker dependencies.
