import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPinnedLookup, fetchPinned } from '../src/utils/outboundHttp.ts';

describe('Outbound requests pinned to SSRF-validated addresses', () => {
  let server: http.Server;
  let port: number;
  let lastHostHeader: string | undefined;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      lastHostHeader = req.headers.host;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('connects to the validated IP without a second DNS lookup, keeping the host name', async () => {
    // `.invalid` can never resolve (RFC 2606): success proves the pinned address was used.
    const resp = await fetchPinned(`http://rebind-target.invalid:${port}/probe`, { method: 'GET' }, [
      '127.0.0.1',
    ]);
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true });
    expect(lastHostHeader).toBe(`rebind-target.invalid:${port}`);
  });

  it('answers both single and "all" lookups with the validated addresses only', () => {
    const lookup = createPinnedLookup(['10.0.0.7', '2001:db8::1']);
    lookup('evil.example', {}, (err, address, family) => {
      expect(err).toBeNull();
      expect(address).toBe('10.0.0.7');
      expect(family).toBe(4);
    });
    lookup('evil.example', { all: true }, (err, address) => {
      expect(err).toBeNull();
      expect(address).toEqual([
        { address: '10.0.0.7', family: 4 },
        { address: '2001:db8::1', family: 6 },
      ]);
    });
  });

  it('refuses to build a lookup without validated addresses', () => {
    expect(() => createPinnedLookup([])).toThrow();
  });
});
