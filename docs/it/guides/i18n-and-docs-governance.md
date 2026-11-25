<div class="erp-docs-lang-bar">
  <span>Lingua:</span>
  <strong>IT</strong>
  <span>·</span>
  <a href="../../en/guides/i18n-and-docs-governance.md">EN (English)</a>
</div>

# Governance i18n, CI & Automazione per Manutenzione Snella

La piattaforma è progettata per una **manutenzione automatizzata a zero drift** (ottimizzata anche per singolo maintainer su GitLab o GitHub): formattazione, linting, typecheck TypeScript, controlli Python Edge Gateway, export statici OpenAPI/Scalar, parità documentale EN/IT e aggiornamento librerie sono automatizzati tramite **hook pre-commit**, **CI gate** e **Renovate**.

---

## Comandi Operativi di Manutenzione

```bash
npm run hooks:install  # Setup una tantum: attiva Husky (.husky/pre-commit) + lint-staged in locale
npm run lint:eslint    # ESLint (Airbnb style guide + React/Hooks/a11y/TS) su frontend e backend
npm run lint:code      # Biome: linter & formatter Rust ultra-rapido (frontend + backend TS/React/JSON/CSS)
npm run lint:fix       # Correzione automatica lint e formattazione (Biome + ESLint Airbnb)
npm run lint           # Typecheck TypeScript rigoroso (tsc --noEmit)
npm run docs:openapi   # Rigenera docs/api/openapi.{en,it,}.json da Zod + i18n
npm run sync:badges    # Allinea i badge Midnight Steel & Brushed Brass in README.md e README.it.md
npm run check:i18n     # Gate CI: parità EN/IT, drift OpenAPI/Scalar, specchio docs, link e badge
npm run verify         # Gate completo: TypeCheck + ESLint + Biome + i18n/OpenAPI + Vitest + build Vite
```

Per il modulo Python Edge Gateway (`project_repo/machine-logs-ml-pipeline/`):

```bash
ruff check project_repo/
ruff format --check project_repo/
```

---

## Controlli Automatici in CI (`npm run check:i18n`)

| Controllo | Invariante Verificata |
| :--- | :--- |
| **1. Parità Namespace** | Stessi file JSON tra `src/i18n/locales/en/` e `src/i18n/locales/it/`. |
| **2. Parità Ricorsiva Chiavi** | Ogni chiave in `en` esiste in `it` (e viceversa) senza valori vuoti. |
| **3. Integrità Segnaposto** | Tutti i segnaposto `{{variabile}}` coincidono tra `en` e `it`. |
| **4. Copertura Rotte OpenAPI** | Ogni rotta registrata in `src/apiSchemas.ts` ha sommari localizzati EN e IT. |
| **5. Drift Statico OpenAPI / Scalar** | `docs/api/openapi.json`, `openapi.en.json` e `openapi.it.json` coincidono byte per byte con gli schemi Zod live. |
| **6. Specchio 1:1 Docs Bilingue** | Ogni pagina in `docs/en/` ha il gemello in `docs/it/` e tutti i percorsi di `zensical.toml` esistono. |
| **7. Integrità Link Relativi** | Tutti i link relativi in `docs/**/*.md`, `README.md` e `README.it.md` puntano a file reali. |
| **8. Allineamento Badge README** | I blocchi badge di `README.md` e `README.it.md` coincidono con `package.json` e metriche live. |

---

## GitLab CI, Pre-Commit & Gestione Automatica Dipendenze

- **Hook Git Pre-Commit (`.husky/pre-commit` + `lint-staged`)**: Esegue automaticamente **ESLint (Airbnb style guide)** e **Biome** sui file TypeScript/React/JSON/CSS in staging, **Ruff** sui file Python in `project_repo/`, typecheck TypeScript e `npm run check:i18n` prima di ogni commit.
- **Pipeline GitLab CI (`.gitlab-ci.yml`)**: Pipeline pronta all'uso in 4 stage (`quality`, `security`, `test`, `build`) con ESLint (Airbnb), Biome, Ruff, `tsc`, drift check EN/IT e OpenAPI, `npm audit`, Vitest, Pytest, build Vite e build del sito statico Zensical (`pages`).
- **Aggiornamento Automatico Dipendenze (`renovate.json`)**: MR settimanali raggruppate per minor/patch (zero rumore per un singolo maintainer) e MR immediate per alert di sicurezza su npm, Python e Docker.
