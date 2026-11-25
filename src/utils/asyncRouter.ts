import type { ErrorRequestHandler, NextFunction, Request, Response, Router } from 'express';
import type { StructuredLogger } from '../logger.ts';

type RouteMethod = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'use' | 'all';
const ROUTE_METHODS: RouteMethod[] = ['get', 'post', 'put', 'patch', 'delete', 'use', 'all'];

function forwardRejections(handler: unknown): unknown {
  // Leave paths, arrays, routers and error handlers (arity 4) untouched.
  if (typeof handler !== 'function' || handler.length === 4) return handler;
  const fn = handler as (req: Request, res: Response, next: NextFunction) => unknown;
  return function asyncSafeHandler(req: Request, res: Response, next: NextFunction) {
    try {
      const result = fn(req, res, next);
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        (result as Promise<unknown>).catch(next);
      }
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Express 4 does not catch rejected promises from async handlers: an unexpected throw becomes
 * an unhandled rejection, which terminates the Node.js process. This patches the router so
 * every registered handler forwards errors to `next(err)` and reaches the JSON error handler.
 */
export function forwardAsyncErrors<T extends Router>(router: T): T {
  for (const method of ROUTE_METHODS) {
    const original = (router[method] as (...args: unknown[]) => unknown).bind(router);
    (router as unknown as Record<RouteMethod, (...args: unknown[]) => unknown>)[method] = (
      ...args: unknown[]
    ) => original(...args.map(forwardRejections));
  }
  return router;
}

/**
 * Terminal error handler: logs the full error server-side and returns a generic 500 body,
 * so internal messages and stack traces never reach the client.
 */
export function createJsonErrorHandler(log: StructuredLogger): ErrorRequestHandler {
  return (err, req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const requestId = res.getHeader('X-Request-Id') ?? null;
    // Client errors raised by middleware (body-parser: malformed JSON 400, payload too large 413).
    const clientStatus = Number((err as { status?: unknown; statusCode?: unknown })?.status ??
      (err as { statusCode?: unknown })?.statusCode);
    if (Number.isInteger(clientStatus) && clientStatus >= 400 && clientStatus < 500) {
      res.status(clientStatus).json({
        error: clientStatus === 413 ? 'Request payload too large.' : 'Malformed request.',
        requestId,
      });
      return;
    }
    log.error('system', 'Unhandled error in request handler', {
      method: req.method,
      path: req.originalUrl,
      requestId,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    res.status(500).json({ error: 'Internal server error.', requestId });
  };
}
