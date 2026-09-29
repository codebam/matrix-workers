// Transport selection for outbound Matrix federation HTTP requests.
//
// Workers fetch() only supports a fixed set of destination ports (443/8443/
// 2053/2083/2087/2096 for https). For any other port it silently connects to
// the scheme-default port instead (cloudflare-docs issue #4299), which breaks
// exactly the Matrix default: peers that listen for federation solely on
// :8448. Requests to those ports are served by a raw TLS socket speaking
// HTTP/1.1 (see ./socket-transport) and still come back as a real Response.
//
// The socket transport is imported lazily so the cloudflare:sockets module is
// only required (and only bundled into the request path) when such a port is
// actually dialed; runtimes without it (e.g. the Node-based unit tests) fall
// back to fetch().

const FETCH_SUPPORTED_PORTS: Record<string, readonly number[]> = {
  'https:': [443, 8443, 2053, 2083, 2087, 2096],
  'http:': [80, 8080, 8880],
};

/**
 * Whether fetch() can be trusted to reach this URL's port. Cloudflare's
 * documented allowlist; anything else silently connects to the scheme
 * default port in production.
 * Exported for unit tests.
 */
export function isFetchSupportedUrl(url: URL): boolean {
  const ports = FETCH_SUPPORTED_PORTS[url.protocol];
  if (!ports) return false;
  const port = url.port ? parseInt(url.port, 10) : url.protocol === 'https:' ? 443 : 80;
  return ports.includes(port);
}

/**
 * fetch() for federation endpoints, transparently using the raw socket
 * transport for ports fetch() cannot reach.
 */
export async function federationFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const parsed = new URL(url);
  if (isFetchSupportedUrl(parsed)) {
    return fetch(url, init);
  }

  let transport: typeof import('./socket-transport') | undefined;
  try {
    transport = await import('./socket-transport');
  } catch (error) {
    console.warn(
      `[federation-http] socket transport unavailable for ${parsed.host}; falling back to fetch() (the port may be ignored):`,
      error
    );
    return fetch(url, init);
  }

  return transport.socketFetchResponse(parsed, init);
}
