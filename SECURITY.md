# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 1.0.x   | Yes       |

## Built-In Security Controls

This platform is engineered for on-premise OT/IT industrial environments and ships with:

- **Multi-Scope M2M Authentication**: Separate SHA-256 hashed credentials for `admin` (`adm_live_`), `read` (`bi_live_`), and `edge` (`gw_live_`) scopes verified via constant-time comparison (`crypto.timingSafeEqual`).
- **RBAC User Sessions & Audit Log**: `scrypt`-hashed operator passwords, revocable session tokens (`sess_...`), optional trusted OIDC proxy headers (`TRUST_PROXY_AUTH_HEADERS`), and an immutable PostgreSQL/JSON audit trail of API mutations.
- **SSRF Protection**: Endpoint probing and Webhook/Mailpit API targets block cloud metadata and link-local IP ranges (`169.254.0.0/16`, `metadata.google.internal`, `0.0.0.0/8`, `fe80::/10`).
- **Secret Redaction in Structured Logs**: Automated recursive redaction of `Authorization`, `X-API-Key`, passwords, SMTP/Webhook secrets, and inline API tokens before writing JSON logs to `stdout`.
- **CSV Formula Injection Protection**: All CSV exports (BA KPI and Audit Log) neutralize leading `=`, `+`, `-`, `@`, tab, and CR characters.
- **Rate Limiting & HTTP Security Headers**: Sliding-window rate limiters on authentication, key rotation, probing, and ingestion endpoints; `X-Content-Type-Options: nosniff` and `X-Powered-By` disabled.

## Reporting a Vulnerability

Please **do not** report security vulnerabilities through public GitHub issues.

1. Use GitHub Security Advisories (**Security -> Advisories -> Report a vulnerability**) on this repository, or email the maintainers privately.
2. Include a clear description of the issue, reproduction steps, affected endpoints/files, and potential impact.
3. We aim to acknowledge reports within **48 hours** and publish a coordinated fix and advisory once verified.
