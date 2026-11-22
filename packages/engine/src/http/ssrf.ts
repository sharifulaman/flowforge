import ipaddr from 'ipaddr.js';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP } from 'node:net';

export class SsrfBlockedError extends Error {
  readonly code = 'SSRF_BLOCKED';
  constructor(
    public readonly host: string,
    public readonly address?: string,
  ) {
    super(
      address
        ? `Requests to ${host} (${address}) are blocked: private, loopback and link-local addresses are not allowed`
        : `Requests to ${host} are blocked: private, loopback and link-local addresses are not allowed`,
    );
    this.name = 'SsrfBlockedError';
  }
}

/**
 * True only for globally routable unicast addresses. Blocks private (RFC1918), loopback,
 * link-local (incl. 169.254.169.254 cloud metadata), CGNAT, multicast, broadcast, reserved,
 * unique-local IPv6, and IPv4-mapped/translated IPv6 forms of any of those.
 */
export function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  let parsed = ipaddr.parse(address);
  if (parsed.kind() === 'ipv6') {
    const v6 = parsed as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) parsed = v6.toIPv4Address();
    else {
      const range = v6.range();
      // 6to4 / Teredo / NAT64 embed IPv4 addresses that could point inside the network.
      if (range !== 'unicast') return false;
      return true;
    }
  }
  return parsed.range() === 'unicast';
}

export interface SsrfOptions {
  /** Hostnames (or literal IPs) exempt from the private-address check, e.g. for tests. */
  allowHosts?: Iterable<string>;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * A `dns.lookup` replacement that refuses non-public results. Because undici connects to
 * exactly the address returned here, validation and connection can't be split by a
 * DNS-rebinding attack.
 */
export function createSafeLookup(opts: SsrfOptions = {}) {
  const allow = new Set([...(opts.allowHosts ?? [])].map((h) => h.toLowerCase()));
  return function safeLookup(hostname: string, options: { all?: boolean } | number | undefined, callback: LookupCallback) {
    const wantAll = typeof options === 'object' && options?.all === true;
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) return callback(err, wantAll ? [] : '');
      if (!allow.has(hostname.toLowerCase())) {
        const blocked = addresses.find((a) => !isPublicAddress(a.address));
        if (blocked) return callback(new SsrfBlockedError(hostname, blocked.address) as NodeJS.ErrnoException, wantAll ? [] : '');
      }
      if (!addresses.length) return callback(Object.assign(new Error(`No addresses for ${hostname}`), { code: 'ENOTFOUND' }), wantAll ? [] : '');
      if (wantAll) return callback(null, addresses);
      callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  };
}

/** Pre-flight URL checks (scheme, credentials, literal IPs). DNS is checked at connect time. */
export function assertSafeUrl(raw: string | URL, opts: SsrfOptions = {}): URL {
  let url: URL;
  try {
    url = new URL(String(raw));
  } catch {
    throw new TypeError(`Invalid URL: ${String(raw)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError(`Only http and https URLs are allowed (got ${url.protocol})`);
  }
  if (url.username || url.password) {
    throw new TypeError('URLs with embedded credentials are not allowed; use headers instead');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const allow = new Set([...(opts.allowHosts ?? [])].map((h) => h.toLowerCase()));
  if (isIP(host) && !allow.has(host) && !isPublicAddress(host)) throw new SsrfBlockedError(host);
  if ((host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) && !allow.has(host)) {
    throw new SsrfBlockedError(host);
  }
  return url;
}
