import type { LookupAddress, LookupOptions } from 'node:dns';
import net from 'node:net';
import { Agent, fetch as undiciFetch, type RequestInit, type Response } from 'undici';

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number
) => void;

/**
 * DNS lookup that always answers with addresses already approved by the SSRF policy
 * (`validateOutboundHost`). The hostname is kept for TLS SNI and certificate verification,
 * but the socket can only connect to a validated IP, closing the DNS rebinding window
 * between validation and connection.
 */
export function createPinnedLookup(addresses: readonly string[]) {
  if (addresses.length === 0) {
    throw new Error('createPinnedLookup requires at least one validated address.');
  }
  const records: LookupAddress[] = addresses.map((address) => ({
    address,
    family: net.isIPv6(address) ? 6 : 4,
  }));
  return (_hostname: string, options: LookupOptions, callback: LookupCallback) => {
    if (options?.all) {
      callback(null, records);
      return;
    }
    callback(null, records[0].address, records[0].family);
  };
}

/**
 * `fetch` bound to pre-validated addresses. Each call gets a short-lived agent whose sockets
 * close soon after use, so pinned addresses never leak into another request.
 */
export function fetchPinned(
  url: string,
  init: RequestInit,
  validatedAddresses: readonly string[]
): Promise<Response> {
  const dispatcher = new Agent({
    connect: { lookup: createPinnedLookup(validatedAddresses) },
    keepAliveTimeout: 1_000,
    keepAliveMaxTimeout: 1_000,
  });
  return undiciFetch(url, { ...init, dispatcher });
}
