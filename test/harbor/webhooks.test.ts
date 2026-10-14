/** Outbound webhooks: the signature header, and the delivery with 3 more tries on server and network errors. */
import { describe, expect, it } from "vitest";
import { deliverWebhook, newWebhookSecret, RETRY_DELAYS_MS, secretHint, SIGNATURE_HEADER, signatureHeader } from "../../src/harbor/webhooks";
import { hmacSha256Hex } from "../../src/directory/crypto";
import { secretLine, SECRET_ONCE, SIGNATURE_HELP } from "../../web/src/views/webhook-copy";
import { steViolations } from "../coord/ste";

/** A webhook receiver that answers from a list (a number is a status; "net" is a network error). */
function receiver(answers: (number | "net")[]) {
  const got: { url: string; headers: Record<string, string>; body: string }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    got.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
    const a = answers.shift() ?? 200;
    if (a === "net") throw new TypeError("fetch failed");
    return new Response("ok", { status: a });
  }) as unknown as typeof fetch;
  return { got, fetchFn };
}

describe("webhook signatures", () => {
  it("signs the time and the body with the secret of the webhook", async () => {
    const secret = newWebhookSecret();
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(secretHint(secret)).toBe(`${secret.slice(0, 10)}…`);
    const body = '{"event":"landing"}';
    const at = Date.UTC(2026, 9, 14, 6, 0, 0);
    const header = await signatureHeader(secret, body, at);
    const t = at / 1000;
    expect(header).toBe(`t=${t},v1=${await hmacSha256Hex(secret, `${t}.${body}`)}`);
  });

  it("sends the signature header, and none for a webhook without a secret", async () => {
    const r = receiver([200, 200]);
    const ok = await deliverWebhook("https://hooks.robin.dev/a", "{}", "whsec_abc", { fetch: r.fetchFn });
    expect(ok).toEqual({ ok: true, tries: 1, status: 200 });
    expect(r.got[0].headers[SIGNATURE_HEADER]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    await deliverWebhook("https://hooks.robin.dev/a", "{}", undefined, { fetch: r.fetchFn });
    expect(r.got[1].headers[SIGNATURE_HEADER]).toBeUndefined();
  });

  it("tries 3 more times on a server error or a network error, each time with a fresh signature", async () => {
    const r = receiver([503, "net", 200]);
    const waits: number[] = [];
    let now = 1_000_000_000_000;
    const res = await deliverWebhook("https://hooks.robin.dev/a", "{}", "whsec_abc", {
      fetch: r.fetchFn,
      sleep: async (ms) => void waits.push(ms),
      now: () => (now += 5000),
    });
    expect(res).toEqual({ ok: true, tries: 3, status: 200 });
    expect(waits).toEqual(RETRY_DELAYS_MS.slice(0, 2));
    const times = r.got.map((g) => /t=(\d+)/.exec(g.headers[SIGNATURE_HEADER])![1]);
    expect(new Set(times).size).toBe(3);

    const down = receiver([500, 500, 500, 500, 500]);
    const failed = await deliverWebhook("https://hooks.robin.dev/a", "{}", undefined, { fetch: down.fetchFn, sleep: async () => undefined });
    expect(failed).toEqual({ ok: false, tries: 4, status: 500 });
    expect(down.got).toHaveLength(4);
  });

  it("does not try again after an answer that is not a server error", async () => {
    const r = receiver([404, 200]);
    const res = await deliverWebhook("https://hooks.robin.dev/a", "{}", "whsec_abc", { fetch: r.fetchFn, sleep: async () => undefined });
    expect(res).toEqual({ ok: false, tries: 1, status: 404 });
    expect(r.got).toHaveLength(1);
  });

  it("explains the signature in Settings in plain words", () => {
    for (const text of [SIGNATURE_HELP, SECRET_ONCE, secretLine({ url: "https://a.b/c" }, undefined), secretLine({ url: "https://a.b/c", newSecret: true }, { url: "https://a.b/c" }), secretLine({ url: "https://a.b/c" }, { url: "https://a.b/c" })]) {
      expect(steViolations(text), text).toEqual([]);
    }
    expect(SIGNATURE_HELP).toContain(SIGNATURE_HEADER);
    expect(secretLine({ url: "https://a.b/d", secretHint: "whsec_Ab12…" }, { url: "https://a.b/c" })).toMatch(/new secret/);
    expect(secretLine({ url: "https://a.b/c", secretHint: "whsec_Ab12…" }, { url: "https://a.b/c" })).toBe("Secret: whsec_Ab12…");
  });
});
