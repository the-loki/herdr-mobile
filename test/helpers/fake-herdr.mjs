// A fake herdr server speaking the real wire protocol, so the client and the
// HTTP layer can be tested without a herdr installation.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/**
 * @param {(req: {id: string, method: string, params: object}, ctx: {push: (frame: object) => void}) => object|undefined} handler
 *   Return a `result` object to reply, or `{error: {code, message}}` to reply with an error.
 *   Return `undefined` to leave the socket open (used by events.subscribe).
 */
export async function startFakeHerdr(handler = () => ({ type: 'pong' })) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-herdr-'));
  const socketPath = path.join(dir, 'herdr.sock');
  const sockets = new Set();
  const calls = [];

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const req = JSON.parse(line);
        calls.push(req);
        const push = (frame) => {
          if (!socket.destroyed) socket.write(JSON.stringify(frame) + '\n');
        };
        const reply = handler(req, { push });
        if (reply && reply.error) {
          push({ id: req.id, error: reply.error });
        } else if (reply) {
          push({ id: req.id, result: reply });
        }
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });

  return {
    socketPath,
    calls,
    callsOf(method) {
      return calls.filter((c) => c.method === method);
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
