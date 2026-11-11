/* Agent WebSocket to the chat service, with reconnect.
 * Plain script (no build): the portal loads it with <script src> and uses
 * window.createChatConnection; Node tests require() it.
 *
 * Every connect asks getToken() for { token, apiUrl } (the agent JWT lives
 * 5 minutes, so a reconnect always fetches one again). On close it reports
 * 'offline', waits backoffMs[min(n, last)] and reconnects; on open it reports
 * 'online' and resets the backoff.
 */
(function () {
  'use strict';

  function createChatConnection({
    getToken,
    WebSocketImpl = typeof WebSocket !== 'undefined' ? WebSocket : undefined,
    onEvent = () => {},
    onStatus = () => {},
    backoffMs = [1000, 2000, 5000, 10000, 30000],
    setTimer = setTimeout,
  }) {
    let ws = null;
    let open = false;
    let stopped = false;
    let attempt = 0;

    function scheduleReconnect() {
      if (stopped) return;
      open = false;
      onStatus('offline');
      const wait = backoffMs[Math.min(attempt, backoffMs.length - 1)];
      attempt += 1;
      setTimer(connect, wait);
    }

    async function connect() {
      if (stopped) return;
      let creds;
      try {
        creds = await getToken();
      } catch {
        scheduleReconnect();
        return;
      }
      if (stopped) return;
      const url = `${String(creds.apiUrl).replace(/^http/, 'ws')}/api/agent/ws?token=${encodeURIComponent(creds.token)}`;
      let sock;
      try {
        sock = new WebSocketImpl(url);
      } catch {
        scheduleReconnect();
        return;
      }
      ws = sock;
      sock.onopen = () => {
        if (ws !== sock || stopped) return;
        open = true;
        attempt = 0;
        onStatus('online');
      };
      sock.onmessage = (e) => {
        if (ws !== sock) return;
        let data;
        try { data = JSON.parse(e.data); } catch { return; }
        if (data && typeof data === 'object') onEvent(data);
      };
      sock.onerror = () => { /* onclose follows */ };
      sock.onclose = () => {
        if (ws !== sock) return;
        ws = null;
        scheduleReconnect();
      };
    }

    connect();

    return {
      send(cmd) {
        if (!ws || !open) return false;
        try { ws.send(JSON.stringify(cmd)); return true; } catch { return false; }
      },
      close() {
        stopped = true;
        open = false;
        const sock = ws;
        ws = null;
        if (sock) { try { sock.close(); } catch { /* already closed */ } }
      },
    };
  }

  if (typeof window !== 'undefined') window.createChatConnection = createChatConnection;
  if (typeof module !== 'undefined' && module.exports) module.exports = { createChatConnection };
})();
