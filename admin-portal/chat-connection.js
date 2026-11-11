/* Agent WebSocket to the chat service, with reconnect.
 * Plain script (no build): the portal loads it with <script src> and uses
 * window.createChatConnection / window.createReplyTracker; Node tests require() it.
 *
 * Every connect asks getToken() for { token, apiUrl } (the agent JWT lives
 * 5 minutes, so a reconnect always fetches one again). On close it reports
 * 'offline', waits backoffMs[min(n, last)] and reconnects; on open it reports
 * 'online' and resets the backoff.
 *
 * Dead-socket detection: browsers answer the server's protocol pings without
 * telling the page, so while open we send an app-level {type:'ping'} every
 * pingMs (the server answers {type:'pong'}). If nothing at all arrives for
 * deadMs, the socket is treated as dead: closed, reported offline, reconnected.
 * 'pong' frames are not passed to onEvent.
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
    pingMs = 15000,
    deadMs = 60000,
    setPingTimer = setTimeout,
    now = Date.now,
  }) {
    let ws = null;
    let open = false;
    let stopped = false;
    let attempt = 0;
    let lastSeen = 0;

    function scheduleReconnect() {
      if (stopped) return;
      open = false;
      onStatus('offline');
      const wait = backoffMs[Math.min(attempt, backoffMs.length - 1)];
      attempt += 1;
      setTimer(connect, wait);
    }

    function heartbeat(sock) {
      setPingTimer(() => {
        if (ws !== sock || stopped) return;
        if (now() - lastSeen >= deadMs) {
          ws = null;
          try { sock.close(); } catch { /* already closing */ }
          scheduleReconnect();
          return;
        }
        try { sock.send('{"type":"ping"}'); } catch { /* onclose follows */ }
        heartbeat(sock);
      }, pingMs);
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
        lastSeen = now();
        onStatus('online');
        heartbeat(sock);
      };
      sock.onmessage = (e) => {
        if (ws !== sock) return;
        lastSeen = now();
        let data;
        try { data = JSON.parse(e.data); } catch { return; }
        if (data && typeof data === 'object' && data.type !== 'pong') onEvent(data);
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

  /* Replies sent but not yet confirmed by the server's agent_sent echo.
   * add() returns the clientId to send with the agent_message; confirm()/fail()
   * resolve it; after timeoutMs onTimeout(entry) fires. Each returns the entry
   * ({ clientId, sessionId, text }) or null if it was already resolved. */
  function createReplyTracker({
    timeoutMs = 10000,
    onTimeout = () => {},
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    makeId = () => `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`,
  } = {}) {
    const pending = new Map(); // clientId -> { clientId, sessionId, text, timer }

    function take(clientId) {
      const p = pending.get(clientId);
      if (!p) return null;
      pending.delete(clientId);
      clearTimer(p.timer);
      return { clientId: p.clientId, sessionId: p.sessionId, text: p.text };
    }

    return {
      add(sessionId, text) {
        const clientId = makeId();
        const entry = { clientId, sessionId, text, timer: null };
        entry.timer = setTimer(() => { const p = take(clientId); if (p) onTimeout(p); }, timeoutMs);
        pending.set(clientId, entry);
        return clientId;
      },
      isPending(sessionId, text) {
        for (const p of pending.values()) if (p.sessionId === sessionId && p.text === text) return true;
        return false;
      },
      confirm: take,
      fail: take,
      failAll() { return [...pending.keys()].map(take); },
      get size() { return pending.size; },
    };
  }

  if (typeof window !== 'undefined') {
    window.createChatConnection = createChatConnection;
    window.createReplyTracker = createReplyTracker;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { createChatConnection, createReplyTracker };
})();
