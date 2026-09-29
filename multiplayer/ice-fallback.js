// TURN is a second attempt, never part of initial ICE gathering.
export const DIRECT_ICE_TIMEOUT_MS = 5_000;
export const RELAY_CREDENTIAL_TIMEOUT_MS = 3_000;

export function createIceFallback({ pc, getRelayIceServers, restart,
  isConnected = () => ['connected', 'completed'].includes(pc.iceConnectionState),
  timeoutMs = DIRECT_ICE_TIMEOUT_MS, onError = () => {},
}) {
  let timer;
  let pending;
  let stopped = false;
  let attempted = false;
  let enabled = false;
  const abort = new AbortController();
  const usable = () => !stopped && pc.signalingState !== 'closed' && !isConnected();
  const clear = () => { clearTimeout(timer); timer = undefined; };
  const enable = () => {
    clear();
    if (pending) return pending;
    if (attempted || !usable() || !getRelayIceServers) return Promise.resolve(false);
    attempted = true;
    pending = (async () => {
      const credentialTimer = setTimeout(() => abort.abort(), RELAY_CREDENTIAL_TIMEOUT_MS);
      try {
        const servers = await getRelayIceServers({ signal: abort.signal });
        if (!usable() || abort.signal.aborted || !servers?.length) return false;
        const configuration = pc.getConfiguration();
        pc.setConfiguration({ ...configuration,
          iceServers: [...(configuration.iceServers ?? []), ...servers],
          iceTransportPolicy: 'all',
        });
        enabled = true;
        return true;
      } finally { clearTimeout(credentialTimer); }
    })();
    return pending;
  };
  let retry;
  const tryFallback = () => {
    if (retry) return retry;
    retry = (async () => {
      try { if (await enable() && usable()) await restart(); }
      catch (error) { if (!stopped) onError(error); }
    })();
    return retry;
  };
  return {
    start() { if (!timer && !attempted && usable()) timer = setTimeout(tryFallback, timeoutMs); },
    enable,
    tryFallback,
    connected: clear,
    stop() { stopped = true; clear(); abort.abort(); },
    get enabled() { return enabled; },
  };
}
