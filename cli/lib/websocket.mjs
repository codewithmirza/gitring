/**
 * Opens a WebSocket (RFC 6455) with plain Node, and reads and writes its frames.
 * Called by commands/watch.mjs through ctx.connect. Tests replace ctx.connect with a fake.
 * Never keep a token here. The caller gives the headers for each connection.
 */
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createHash, randomBytes } from "node:crypto";
import { VERSION } from "./constants.mjs";

// ───── Frames ─────

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const WS_MAX_FRAME = 64 * 1024 * 1024;

/** One client frame (RFC 6455 §5.2): FIN, the opcode, the length, and the payload under a random mask. */
export function wsFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  const mask = randomBytes(4);
  let head;
  if (data.length < 126) {
    head = Buffer.alloc(2);
    head[1] = 0x80 | data.length;
  } else if (data.length < 65536) {
    head = Buffer.alloc(4);
    head[1] = 0x80 | 126;
    head.writeUInt16BE(data.length, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(data.length), 2);
  }
  head[0] = 0x80 | opcode;
  const body = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) body[i] = data[i] ^ mask[i % 4];
  return Buffer.concat([head, mask, body]);
}

/**
 * Read frames from a buffer. Answers the complete frames and the bytes that are left (a frame that is
 * not complete yet). Server frames have no mask, but a masked frame is read too.
 */
export function wsReadFrames(buf) {
  const frames = [];
  let rest = buf;
  for (;;) {
    if (rest.length < 2) break;
    const fin = (rest[0] & 0x80) !== 0;
    const opcode = rest[0] & 0x0f;
    const masked = (rest[1] & 0x80) !== 0;
    let len = rest[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (rest.length < 4) break;
      len = rest.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (rest.length < 10) break;
      const big = rest.readBigUInt64BE(2);
      if (big > BigInt(WS_MAX_FRAME)) throw new Error("A frame from the server is too large.");
      len = Number(big);
      off = 10;
    }
    const maskAt = off;
    if (masked) off += 4;
    if (rest.length < off + len) break;
    let payload = Buffer.from(rest.subarray(off, off + len));
    if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= rest[maskAt + (i % 4)];
    frames.push({ fin, opcode, payload });
    rest = rest.subarray(off + len);
  }
  return { frames, rest };
}

// ───── The connection ─────

/**
 * Open a WebSocket (RFC 6455) with headers (a browser WebSocket cannot send Authorization). Calls
 * `on.text(string)` for each text message and `on.close(code, reason)` once at the end. Answers send(text)
 * and close().
 */
export function openSocket(url, headers, on) {
  const u = new URL(url);
  const secure = u.protocol === "wss:" || u.protocol === "https:";
  const key = randomBytes(16).toString("base64");
  let socket = null;
  let ended = false;
  const end = (code, reason) => {
    if (ended) return;
    ended = true;
    // A server that does not close its side must not keep the program alive.
    if (socket) setTimeout(() => socket.destroy(), 1000).unref?.();
    on.close(code, reason);
  };
  const req = (secure ? httpsRequest : httpRequest)({
    hostname: u.hostname.replace(/^\[|\]$/g, ""),
    port: u.port || (secure ? 443 : 80),
    path: `${u.pathname}${u.search}`,
    method: "GET",
    headers: { ...headers, connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": key, "user-agent": `gitring-cli/${VERSION}` },
  });
  req.on("upgrade", (res, sock, head) => {
    socket = sock;
    const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
    if (res.headers["sec-websocket-accept"] !== accept) {
      sock.destroy();
      end(1002, "The server did not accept the WebSocket.");
      return;
    }
    const feed = messageReader(sock, on, end, () => ended);
    sock.on("data", feed);
    sock.on("close", () => end(1006, "The connection closed."));
    sock.on("error", () => end(1006, "The connection failed."));
    on.open?.();
    // Frames that came with the answer of the upgrade (even a close frame) are read at once.
    if (head?.length) feed(Buffer.from(head));
  });
  req.on("response", (res) => {
    res.resume();
    end(res.statusCode === 401 ? 4401 : res.statusCode === 403 || res.statusCode === 404 ? 4403 : 1006, `The server answered ${res.statusCode}.`);
  });
  req.on("error", (e) => end(1006, String(e?.message ?? e)));
  req.end();
  return {
    send(text) {
      if (socket && !ended) socket.write(wsFrame(0x1, text));
    },
    close() {
      if (socket && !ended) {
        try {
          socket.end(wsFrame(0x8, Buffer.from([0x03, 0xe8])));
        } catch {
          /* closed */
        }
      }
      end(1000, "");
    },
  };
}

/**
 * Read the bytes of the socket. Answers a function that takes each chunk. It calls `on.text` for each whole
 * message, and `end` when the server closes the connection or sends a frame that is too large.
 */
function messageReader(sock, on, end, isEnded) {
  let buf = Buffer.alloc(0);
  let parts = [];
  const feed = (chunk) => {
    if (isEnded()) return;
    buf = Buffer.concat([buf, chunk]);
    let read;
    try {
      read = wsReadFrames(buf);
    } catch (e) {
      sock.destroy();
      end(1009, String(e?.message ?? e));
      return;
    }
    buf = read.rest;
    for (const f of read.frames) {
      if (f.opcode === 0x8) {
        const code = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1005;
        const reason = f.payload.subarray(2).toString("utf8");
        try {
          sock.end(wsFrame(0x8, f.payload.subarray(0, 2)));
        } catch {
          /* closed */
        }
        end(code, reason);
        return;
      }
      if (f.opcode === 0x9) sock.write(wsFrame(0xa, f.payload));
      else if (f.opcode === 0x1 || f.opcode === 0x2 || f.opcode === 0x0) {
        parts.push(f.payload);
        if (f.fin) {
          const whole = Buffer.concat(parts);
          parts = [];
          on.text(whole.toString("utf8"));
        }
      }
    }
  };
  return feed;
}
