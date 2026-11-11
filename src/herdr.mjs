// Minimal herdr socket client.
//
// Two facts from the live protocol shape this file:
//  - A request/response exchange takes its own connection; the server closes
//    the socket after one reply. Only `events.subscribe` keeps it open.
//  - Frames are newline-delimited JSON. Requests need a string id.
import net from 'node:net';

export class HerdrError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HerdrError';
    this.code = code;
  }
}

export class HerdrClient {
  #socketPath;
  #timeoutMs;
  #seq = 0;

  constructor({ socketPath, timeoutMs = 15000 }) {
    if (!socketPath) throw new Error('HerdrClient needs a socketPath');
    this.#socketPath = socketPath;
    this.#timeoutMs = timeoutMs;
  }

  get socketPath() {
    return this.#socketPath;
  }

  /** Send one request on a fresh connection and resolve its `result`. */
  async rpc(method, params = {}) {
    const id = `hmw-${++this.#seq}`;
    return await new Promise((resolve, reject) => {
      const socket = net.createConnection(this.#socketPath);
      let buffer = '';
      let settled = false;

      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        fn(value);
      };

      const timer = setTimeout(
        () => settle(reject, new HerdrError('timeout', `${method} got no reply in ${this.#timeoutMs}ms`)),
        this.#timeoutMs,
      );

      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf('\n');
        if (newline === -1) return;
        let frame;
        try {
          frame = JSON.parse(buffer.slice(0, newline));
        } catch (error) {
          settle(reject, new HerdrError('bad_response', `unreadable reply to ${method}: ${error.message}`));
          return;
        }
        if (frame.error) {
          settle(reject, new HerdrError(frame.error.code ?? 'herdr_error', frame.error.message ?? 'herdr error'));
          return;
        }
        settle(resolve, frame.result ?? {});
      });
      socket.on('error', (error) => settle(reject, new HerdrError('socket_error', error.message)));
      socket.on('close', () => settle(reject, new HerdrError('closed', `connection closed before ${method} replied`)));

      socket.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  /**
   * Keep a long-lived event subscription. Reconnects on drops with backoff;
   * `update()` replaces the subscription set.
   */
  subscribe({ subscriptions, onEvent = () => {}, onStatus = () => {} }) {
    let wanted = subscriptions;
    let closed = false;
    let socket = null;
    let retryTimer = null;
    let attempt = 0;

    const connect = () => {
      if (closed) return;
      let buffer = '';
      socket = net.createConnection(this.#socketPath);
      socket.setEncoding('utf8');
      socket.on('connect', () => {
        attempt = 0;
        onStatus('connected');
        socket.write(JSON.stringify({ id: `hmw-sub-${++this.#seq}`, method: 'events.subscribe', params: { subscriptions: wanted } }) + '\n');
      });
      socket.on('data', (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          let frame;
          try {
            frame = JSON.parse(line);
          } catch {
            continue; // a broken frame must not kill the stream
          }
          if (frame.event) onEvent(frame.event, frame.data ?? {});
        }
      });
      const drop = () => {
        socket?.destroy();
        socket = null;
        if (closed) return;
        onStatus('disconnected');
        const delay = Math.min(5000, 250 * 2 ** attempt++);
        retryTimer = setTimeout(connect, delay);
      };
      socket.on('error', drop);
      socket.on('close', drop);
    };

    connect();

    return {
      update(nextSubscriptions) {
        if (JSON.stringify(nextSubscriptions) === JSON.stringify(wanted)) return;
        wanted = nextSubscriptions;
        attempt = 0;
        clearTimeout(retryTimer);
        if (socket) {
          socket.removeAllListeners('close');
          socket.destroy();
          socket = null;
        }
        connect();
      },
      close() {
        closed = true;
        clearTimeout(retryTimer);
        if (socket) {
          const dying = socket;
          socket = null;
          dying.removeAllListeners('close');
          dying.destroy();
        }
        onStatus('disconnected');
      },
    };
  }
}
