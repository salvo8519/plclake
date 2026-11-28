import type express from 'express';
import type { Express, Request, Response } from 'express';
import { apiReference } from '@scalar/express-api-reference';
import { getOpenApiLocale } from '../../apiSchemas.ts';
import { LANGUAGE_COOKIE_NAME, type SupportedLanguage } from '../../i18n/types.ts';
import { buildScalarTopBarHtml, WHITE_LABEL_EDITORIAL_CSS } from '../../serverConfig.ts';
import { resolveRequestLanguage } from '../requestInput.ts';
import type { HttpContext } from '../context.ts';

/** Bilingual (EN/IT) Scalar API reference at /api/v1/docs, its legacy alias and the /docs redirect. */
export function registerDocsRoutes(app: Express, ctx: HttpContext): void {
  const { connectionManager } = ctx;

  // Bilingual White-label Editorial Finance Scalar OpenAPI 3.1 Reference UI
  const scalarCdnOverride = process.env.SCALAR_CDN_URL?.trim() || undefined;
  const buildScalarMiddleware = (lang: SupportedLanguage) => {
    const locale = getOpenApiLocale(lang);
    return apiReference({
      url: `/api/v1/openapi.json?lang=${lang}`,
      ...(scalarCdnOverride ? { cdn: scalarCdnOverride } : {}),
      pageTitle: locale.pageTitle,
      theme: 'default',
      darkMode: false,
      hideDarkModeToggle: true,
      hideClientButton: true,
      showDeveloperTools: 'never',
      telemetry: false,
      authentication: {
        preferredSecurityScheme: 'ApiKeyHeaderAuth',
      },
      customCss: WHITE_LABEL_EDITORIAL_CSS,
    });
  };

  const scalarHandlers: Record<SupportedLanguage, express.RequestHandler> = {
    en: buildScalarMiddleware('en') as unknown as express.RequestHandler,
    it: buildScalarMiddleware('it') as unknown as express.RequestHandler,
  };

  const serveBilingualScalar = (docsBasePath: string) => (req: Request, res: Response, next: express.NextFunction) => {
    const lang = resolveRequestLanguage(req);
    const locale = getOpenApiLocale(lang);
    res.setHeader('Content-Language', lang);
    res.setHeader('Vary', 'Accept-Language, Cookie');
    res.setHeader(
      'Set-Cookie',
      `${LANGUAGE_COOKIE_NAME}=${lang}; Path=/; Max-Age=31536000; SameSite=Lax`
    );

    const topBar = buildScalarTopBarHtml({
      lang,
      brand: locale.header.brand,
      subtitle: locale.header.subtitle,
      backToConsole: locale.header.backToConsole,
      docsBasePath,
      authEnforced: connectionManager.isAuthEnforced(),
    });

    const originalSend = res.send.bind(res);
    res.send = ((body?: unknown) => {
      if (typeof body === 'string' && body.includes('<html')) {
        let html = body.replace(/<html(?:\s+lang="[^"]*")?/, `<html lang="${lang}"`);
        if (html.includes('<body')) {
          html = html.replace(/<body([^>]*)>/, `<body$1>${topBar}`);
        } else {
          html = `${topBar}${html}`;
        }
        return originalSend(html);
      }
      return originalSend(body);
    }) as Response['send'];

    scalarHandlers[lang](req, res, next);
  };

  app.use('/api/v1/docs', serveBilingualScalar('/api/v1/docs'));
  app.use('/api/docs', serveBilingualScalar('/api/v1/docs'));
  app.get('/docs', (req, res) => {
    const lang = resolveRequestLanguage(req);
    res.redirect(`/api/v1/docs?lang=${lang}`);
  });
}
