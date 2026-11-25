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
npm run lint:code      # Biome: ultra-fast Rust linter & formatter check (frontend + backend TS/React/JSON/CSS)
npm run lint:fix       # Auto-fix formatting & lint issues (Biome + ESLint Airbnb)
npm run lint           # TypeScript strict typecheck (tsc --noEmit)
npm run docs:openapi   # Regenerate docs/api/openapi.{en,it,}.json from Zod + i18n
npm run sync:badges    # Sync Midnight Steel & Brushed Brass README badges from code
npm run check:i18n     # CI Gate: EN/IT parity, OpenAPI/Scalar drift, docs mirror, links & badges
npm run verify         # Full solo-maintainer gate: TypeCheck + ESLint + Biome + i18n/OpenAPI + Vitest + Vite build
```

For the Python Edge Gateway (`project_repo/machine-logs-ml-pipeline/`):

```bash
ruff check project_repo/
ruff format --check project_repo/
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

- **Git Pre-Commit Hook (`.husky/pre-commit` + `lint-staged`)**: Automatically runs **ESLint (Airbnb style guide)** and **Biome** on staged TypeScript/React/JSON/CSS files, **Ruff** on staged Python files in `project_repo/`, TypeScript `tsc --noEmit`, and `npm run check:i18n` before every commit.
- **GitLab CI Pipeline (`.gitlab-ci.yml`)**: Ready-to-run 4-stage pipeline (`quality`, `security`, `test`, `build`) covering ESLint (Airbnb), Biome, Ruff, `tsc`, EN/IT & OpenAPI drift check, `npm audit`, Vitest, Pytest, Vite production build, and Zensical static site build (`pages`).
- **Automated Dependency Updates (`renovate.json`)**: Weekly grouped non-major updates (low noise for a solo maintainer) plus immediate security vulnerability MRs for npm, Python, and Docker dependencies.
