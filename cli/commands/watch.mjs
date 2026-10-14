/**
 * The command watch: shows the live log of a project over a WebSocket, and connects again when it drops.
 * Called through commands/index.mjs. It runs until the person presses Ctrl+C or the retries are used.
 * Never print a log line without ctx.out (it removes control characters). Read next: lib/websocket.mjs.
 */
import { CliError } from "../lib/errors.mjs";
import { clock } from "../lib/format.mjs";
import { bearer, session } from "../lib/session.mjs";

/**
 * One live connection: resolves with the close code, the reason, and `opened` (false: the server refused the
 * connection). `onLive` runs when the first state arrives.
 */
function watchOnce(ctx, s, project, token, seen, onLive) {
  return new Promise((resolve) => {
    let ping = null;
    let sock = null;
    let opened = false;
    const url = `${s.origin.replace(/^http/, "ws")}/ws/${encodeURIComponent(project)}`;
    const print = (log) => {
      if (!log?.id || seen.has(log.id)) return;
      seen.add(log.id);
      if (seen.size > 5000) seen.delete(seen.values().next().value);
      ctx.out(ctx.flags.json ? JSON.stringify(log) : `${clock(Number(log.at ?? ctx.now()))}  ${log.message}`);
    };
    sock = ctx.connect(url, { authorization: `Bearer ${token}` }, {
      open() {
        opened = true;
        // The server answers "pong". It keeps the connection open through proxies.
        ping = setInterval(() => sock?.send("ping"), 30_000);
        ping.unref?.();
      },
      text(raw) {
        if (raw === "pong") return;
        let msg;
        try {
          msg = JSON.parse(raw);
        } catch {
          return;
        }
        for (const ev of Array.isArray(msg) ? msg : [msg]) {
          if (ev?.type === "snapshot") {
            const logs = ev.state?.logs ?? [];
            if (!seen.size) for (const log of logs.slice(-10)) print(log);
            else for (const log of logs) print(log);
            onLive();
          } else if (ev?.type === "log") print(ev.log);
        }
      },
      close(code, reason) {
        if (ping) clearInterval(ping);
        resolve({ code, reason, opened });
      },
    });
  });
}

/** gitring watch <project>: print the live log, and connect again with growing waits when the connection drops. */
export async function watch(ctx, [project]) {
  const s = session(ctx);
  const seen = new Set();
  if (!ctx.flags.json) ctx.out(`The live log of ${project}. Press Ctrl+C to stop.`);
  let tries = 0;
  // A sign-in renews its token once when the server refuses it (bearer stops when the sign-in ended).
  let renew = false;
  let renewed = false;
  for (;;) {
    let live = false;
    const { code, reason, opened } = await watchOnce(ctx, s, project, await bearer(ctx, s, renew), seen, () => {
      live = true;
    });
    renew = false;
    if (opened) renewed = false;
    if (!opened && code === 4401 && s.kind === "oauth" && !renewed) {
      renew = renewed = true;
      continue;
    }
    if (!opened && code === 4401) throw new CliError(s.kind === "key" ? "The key in GITRING_TOKEN is not valid." : `Your sign-in to ${s.origin} ended. Run: gitring login --server ${s.origin}`);
    if (!opened && code === 4403) throw new CliError(`You cannot watch ${project}. The project does not exist, or your access changed. ${reason}`.trim());
    // A deploy or a restart of the project closes the connection. So does a change of access, or a sign-out of
    // the person in a browser (4401, 4403): the next connection shows if the access is still there.
    // Connect again, a little later each time.
    tries = live ? 1 : tries + 1;
    if (tries > ctx.watchRetries) throw new CliError(`The live log stopped. ${reason || "The connection closed."}`.trim());
    await ctx.sleep(Math.min(30_000, 1000 * 2 ** (tries - 1)));
  }
}
