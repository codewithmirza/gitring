/**
 * The routes of the waitlist: the choice of a person, the list for the owner and the owner page.
 *
 * Mounted by app.ts. Only an owner reads the list or lets a person in.
 * Read next: src/worker/gate.ts (who is kept out) and src/core/waitlist.ts.
 */
import type { Hono } from "hono";
import { esc, forgetPrincipal, directory, page } from "./auth";
import { gateOn, waitlistCsv } from "../core/waitlist";
import { PLANS, priceLabel } from "../core/plans";
import type { C, HonoEnv } from "./http";

/*
 * The routes:
 *
 *   GET    /api/plans               the planned packs (public)
 *   GET    /api/waitlist            the gate and the choice of the signed-in person
 *   PUT    /api/waitlist            { pack, note }  keep the choice (also changes an old choice)
 *   DELETE /api/waitlist            take the interest back
 *   GET    /api/admin/waitlist      owner: people, counts for each pack, monthly value (?format=csv for a file)
 *   GET    /api/admin/allowed       owner: the people that the owner let in
 *   POST   /api/admin/allowed       owner: { email }  let a person in (an email, or user:<account id>)
 *   DELETE /api/admin/allowed/:entry   owner: take the access back
 *   GET    /admin/waitlist          owner: the same as a page, with forms (no script)
 *   GET    /api/projects/:p/usage   the counters of use of a project in a month
 */

function owner(c: C): boolean {
  const p = c.get("principal");
  return p.via === "operator" || Boolean(p.user?.admin);
}

const NOT_OWNER = { error: "Only an owner of this gitring can do this." };

export function waitlistRoutes(app: Hono<HonoEnv>): void {
  personWaitlistRoutes(app);
  adminApiRoutes(app);
  adminPageRoutes(app);
}

/** The plans, and the waitlist choice of the person. */
function personWaitlistRoutes(app: Hono<HonoEnv>): void {
  app.get("/api/plans", (c) => c.json(PLANS, 200, { "cache-control": "public, max-age=300" }));

  app.get("/api/waitlist", async (c) => {
    const user = c.get("principal").user;
    const state = await directory(c.env).waitlistState(user?.id ?? null);
    return c.json(state ?? { gate: false });
  });

  app.put("/api/waitlist", async (c) => {
    const user = c.get("principal").user;
    if (!user) return c.json({ error: "Sign in first." }, 401);
    if (!gateOn(c.env)) return c.json({ error: "This gitring has no waitlist." }, 404);
    const body = await c.req.json<{ pack?: unknown; note?: unknown }>().catch(() => ({}) as { pack?: unknown; note?: unknown });
    try {
      return c.json(await directory(c.env).waitlistSet(user.id, body.pack, body.note));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  app.delete("/api/waitlist", async (c) => {
    const user = c.get("principal").user;
    if (!user) return c.json({ error: "Sign in first." }, 401);
    await directory(c.env).waitlistRemove(user.id);
    return c.body(null, 204);
  });

  /* ───────────── owner ───────────── */
}

/** The waitlist and the allow list for an owner (API). */
function adminApiRoutes(app: Hono<HonoEnv>): void {
  app.get("/api/admin/waitlist", async (c) => {
    if (!owner(c)) return c.json(NOT_OWNER, 403);
    const report = await directory(c.env).waitlistAdmin();
    if (c.req.query("format") === "csv") {
      return new Response(waitlistCsv(report.people), {
        headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="gitring-waitlist.csv"', "cache-control": "private, no-store" },
      });
    }
    return c.json({ ...report, gate: gateOn(c.env) });
  });

  app.get("/api/admin/allowed", async (c) => {
    if (!owner(c)) return c.json(NOT_OWNER, 403);
    return c.json(await directory(c.env).allowedList());
  });

  app.post("/api/admin/allowed", async (c) => {
    if (!owner(c)) return c.json(NOT_OWNER, 403);
    const body = await c.req.json<{ email?: unknown; entry?: unknown }>().catch(() => ({}) as { email?: unknown; entry?: unknown });
    try {
      const entry = await directory(c.env).allowedAdd(body.email ?? body.entry, c.get("principal").user?.id ?? null);
      forgetPrincipal({ all: true });
      return c.json({ entry }, 201);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  app.delete("/api/admin/allowed/:entry", async (c) => {
    if (!owner(c)) return c.json(NOT_OWNER, 403);
    const had = await directory(c.env).allowedRemove(decodeURIComponent(c.req.param("entry")));
    forgetPrincipal({ all: true });
    return had ? c.body(null, 204) : c.json({ error: "This person is not on the list." }, 404);
  });

  /* ───────────── the owner page ───────────── */
}

/** The owner page of the waitlist. */
function adminPageRoutes(app: Hono<HonoEnv>): void {
  app.get("/admin/waitlist", async (c) => {
    if (!owner(c)) {
      return page("Waitlist", `<h1>Only an owner can open this page</h1><p><a class="btn" href="/">Open gitring</a></p>`, 403);
    }
    return adminPage(c, c.req.query("done") ?? null);
  });

  app.post("/admin/waitlist/allow", async (c) => {
    if (!owner(c)) return page("Waitlist", `<h1>Only an owner can do this</h1>`, 403);
    const form = await c.req.parseBody();
    try {
      await directory(c.env).allowedAdd(form.entry, c.get("principal").user?.id ?? null);
      forgetPrincipal({ all: true });
      return c.redirect("/admin/waitlist?done=added", 303);
    } catch (e) {
      return adminPage(c, null, (e as Error).message, 400);
    }
  });

  app.post("/admin/waitlist/remove", async (c) => {
    if (!owner(c)) return page("Waitlist", `<h1>Only an owner can do this</h1>`, 403);
    const form = await c.req.parseBody();
    await directory(c.env).allowedRemove(form.entry);
    forgetPrincipal({ all: true });
    return c.redirect("/admin/waitlist?done=removed", 303);
  });
}

const DONE: Record<string, string> = { added: "The person can use gitring now.", removed: "The person has no access now." };

async function adminPage(c: C, done: string | null, problem?: string, status = 200): Promise<Response> {
  const dir = directory(c.env);
  const [report, allowed] = await Promise.all([dir.waitlistAdmin(), dir.allowedList()]);
  const when = (t: number) => new Date(t).toISOString().slice(0, 10);
  const packs = PLANS.map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(priceLabel(p))}</td><td>${report.byPack[p.id]}</td></tr>`).join("");
  const rows = report.people
    .map((e) => {
      const target = e.email ?? `user:${e.userId}`;
      return `<tr><td>${esc(e.name)}</td><td>${esc(e.email ?? "no email")}</td><td>${esc(e.provider)}</td><td>${esc(e.pack)}</td><td>${esc(e.note)}</td><td>${when(e.updatedAt)}</td><td>${
        e.allowed
          ? `<span class="ok">In</span>`
          : `<form method="post" action="/admin/waitlist/allow"><input type="hidden" name="entry" value="${esc(target)}"><button type="submit">Let in</button></form>`
      }</td></tr>`;
    })
    .join("");
  const list = allowed
    .map(
      (a) =>
        `<tr><td><code>${esc(a.entry)}</code></td><td>${when(a.addedAt)}</td><td><form method="post" action="/admin/waitlist/remove"><input type="hidden" name="entry" value="${esc(a.entry)}"><button type="submit" class="secondary">Remove</button></form></td></tr>`,
    )
    .join("");
  const status2 = gateOn(c.env) ? `<p class="ok">The gate is on.</p>` : `<p class="warn">The gate is off. Everybody who signs in can use gitring.</p>`;
  return page(
    "Waitlist",
    `<h1>Waitlist</h1>${status2}${done && DONE[done] ? `<p class="ok">${esc(DONE[done])}</p>` : ""}${problem ? `<p class="warn" role="alert">${esc(problem)}</p>` : ""}
<div class="card"><h2>${report.total} ${report.total === 1 ? "person" : "people"} chose a pack</h2>
<p>Interest in planned prices: <b>$${report.monthlyValueUsd.toLocaleString("en-US")}</b> each month. An Enterprise choice counts its start price.</p>
<table><tr><th>Pack</th><th>Planned price</th><th>People</th></tr>${packs}</table>
<p><a class="btn secondary" href="/api/admin/waitlist?format=csv">Download CSV</a></p></div>
<div class="card"><h2>People</h2>${rows ? `<table><tr><th>Name</th><th>Email</th><th>Sign-in</th><th>Pack</th><th>Note</th><th>Updated</th><th></th></tr>${rows}</table>` : `<p class="muted">Nobody chose a pack yet.</p>`}</div>
<div class="card"><h2>Let a person in</h2>
<form method="post" action="/admin/waitlist/allow"><label for="entry">Email address</label><input id="entry" name="entry" type="email" required autocomplete="off" placeholder="name@example.com"><p><button type="submit">Let in</button></p></form>
${list ? `<table><tr><th>Entry</th><th>Added</th><th></th></tr>${list}</table>` : `<p class="muted">You let nobody in yet. The secret ALLOWLIST_EMAILS has its own list.</p>`}</div>
<style>table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}form{margin:0}button.secondary{background:transparent;color:var(--accent)}</style>`,
    status,
  );
}
