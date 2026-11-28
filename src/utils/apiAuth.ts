const LEGACY_SESSION_KEY_STORAGE = 'telemetry_console_api_key';

// Hold active console session tokens strictly in JS memory (never localStorage/sessionStorage)
let inMemorySessionApiKey: string | null = null;

if (typeof window !== 'undefined') {
  try {
    window.sessionStorage.removeItem(LEGACY_SESSION_KEY_STORAGE);
  } catch {
    // Ignore storage access errors in sandboxed iframes
  }
}

export function getSessionApiKey(): string | null {
  return inMemorySessionApiKey;
}

export function setSessionApiKey(token: string | null): void {
  inMemorySessionApiKey = token?.trim() ? token.trim() : null;
  if (typeof window !== 'undefined') {
    try {
      window.sessionStorage.removeItem(LEGACY_SESSION_KEY_STORAGE);
    } catch {
      // Ignore storage access errors in sandboxed iframes
    }
  }
}

/**
 * Wrapper around native fetch that attaches the active session Admin API key
 * (if rotated/stored in this browser session) as X-API-Key on same-origin
 * /api/* requests without mutating window.fetch.
 */
export function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const token = getSessionApiKey();
  if (!token) {
    return fetch(input, init);
  }

  const urlStr =
    typeof input === 'string'
      ? input
      : input instanceof URL
      ? input.pathname
      : input.url;

  const isSameOriginApi =
    urlStr.startsWith('/api/') ||
    (typeof window !== 'undefined' && urlStr.startsWith(`${window.location.origin}/api/`));

  if (!isSameOriginApi) {
    return fetch(input, init);
  }

  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined)
  );
  if (
    !headers.has('Authorization') &&
    !headers.has('X-API-Key') &&
    !headers.has('X-Gateway-Token')
  ) {
    headers.set('X-API-Key', token);
  }

  return fetch(input, { ...init, headers });
}
