const TURN_CREDENTIALS_PATH = '/api/turn-credentials';
const TURN_CREDENTIAL_TTL_SECONDS = 6 * 60 * 60;
const isBrowserIceUrl = (url) => typeof url === 'string'
  && !/^(?:stun|turns?):[^/?#]+:53(?:[/?#]|$)/i.test(url);

function browserIceServers(iceServers) {
  return iceServers.flatMap((server) => {
    const urls = Array.isArray(server?.urls) ? server.urls : [server?.urls];
    const supported = [...new Set(urls.filter(isBrowserIceUrl))];
    if (!supported.length) return [];
    return [{ ...server, urls: Array.isArray(server.urls) ? supported : supported[0] }];
  });
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  });
}

export async function turnCredentials(request, env, {
  fetcher = fetch,
  createIdentifier = () => crypto.randomUUID(),
} = {}) {
  const requestUrl = new URL(request.url);
  if (request.method !== 'POST') {
    return json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST for TURN credentials.' } }, 405, {
      allow: 'POST',
    });
  }
  if (request.headers.get('origin') !== requestUrl.origin) {
    return json({ error: { code: 'ORIGIN_DENIED', message: 'TURN credentials are only issued to this game.' } }, 403);
  }
  if (!env.TURN_KEY_ID || !env.TURN_KEY_TOKEN) {
    return json({ error: { code: 'TURN_NOT_CONFIGURED', message: 'WebRTC relay fallback is not configured.' } }, 503, {
      'retry-after': '30',
    });
  }

  try {
    const upstream = await fetcher(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.TURN_KEY_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ttl: TURN_CREDENTIAL_TTL_SECONDS,
          customIdentifier: `saturn-devouring-${createIdentifier()}`,
        }),
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!upstream.ok) throw new Error(`TURN credential service returned ${upstream.status}`);
    const payload = await upstream.json();
    if (!Array.isArray(payload?.iceServers)) throw new Error('TURN credential response was malformed');
    return json({ iceServers: browserIceServers(payload.iceServers) });
  } catch (error) {
    console.error(JSON.stringify({ event: 'turn_credentials_failed', message: error?.message || String(error) }));
    return json({ error: { code: 'TURN_UNAVAILABLE', message: 'WebRTC relay credentials are temporarily unavailable.' } }, 503, {
      'retry-after': '15',
    });
  }
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === TURN_CREDENTIALS_PATH) {
      // The existing Worker owns the TURN secrets. Route the new hostname's
      // same-origin request to it internally so credentials need not be copied.
      if (env.LEGACY_API) return env.LEGACY_API.fetch(request);
      return turnCredentials(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
