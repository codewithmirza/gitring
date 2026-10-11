/** The client sends an answer to a question, and a refusal comes back as an answer with a sentence, not as an error. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Call {
  url: string;
  method: string;
  body: unknown;
}

let calls: Call[] = [];
let reply: () => Response;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  calls = [];
  reply = () => json({ ok: true });
  (globalThis as { location?: unknown }).location = { pathname: "/approve/at_1", search: "?project=shop", hash: "", origin: "http://gitring.test" };
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined });
    return reply();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const approval = { id: "ap_1", status: "waiting", reason: "project-asks", why: ["x"], digest: "d", askedAt: 1 };

describe("decide", async () => {
  const { LiveHarbor, ApiError } = await import("../../web/src/state/api");

  it("posts the question that the person saw and the answer", async () => {
    reply = () => json({ attemptId: "at_1", outcome: "approved", approval: { ...approval, status: "approved" }, status: "landed", message: "Merged by fast-forward at abc1234." });
    const res = await new LiveHarbor("shop").decide("at_1", { approvalId: "ap_1", answer: "approve" });
    expect(calls).toEqual([{ url: "/api/projects/shop/attempts/at_1/decide", method: "POST", body: { approvalId: "ap_1", answer: "approve" } }]);
    expect(res.outcome).toBe("approved");
    expect(res.message).toBe("Merged by fast-forward at abc1234.");
  });

  it("sends the note of a send-back", async () => {
    reply = () => json({ attemptId: "at_1", outcome: "sent-back", approval: { ...approval, status: "sent-back" }, status: "underway", message: "The work went back to the agent with your note." });
    await new LiveHarbor("shop").decide("at_1", { approvalId: "ap_1", answer: "send-back", note: "Keep the old name." });
    expect(calls[0].body).toEqual({ approvalId: "ap_1", answer: "send-back", note: "Keep the old name." });
  });

  it("returns a refusal (status 403) as a result with the sentence of the Worker", async () => {
    reply = () => json({ attemptId: "at_1", outcome: "refused", approval, status: "ready", message: "Only Sam (who sent the agent) or an owner of the project can answer this." }, 403);
    const res = await new LiveHarbor("shop").decide("at_1", { approvalId: "ap_1", answer: "approve" });
    expect(res.outcome).toBe("refused");
    expect(res.message).toBe("Only Sam (who sent the agent) or an owner of the project can answer this.");
  });

  it("keeps the other errors as errors with a readable message", async () => {
    reply = () => json({ error: "You need the member role on this project. Ask an owner." }, 403);
    const err = await new LiveHarbor("shop").decide("at_1", { approvalId: "ap_1", answer: "approve" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as Error).message).toBe("You need the member role on this project. Ask an owner.");
    expect((err as { status: number }).status).toBe(403);

    reply = () => json({ error: "This work copy has no question to answer." }, 400);
    await expect(new LiveHarbor("shop").decide("at_1", { approvalId: "ap_1", answer: "approve" })).rejects.toThrow("This work copy has no question to answer.");
  });

  it("does not take a 403 without the result of a refusal for one", async () => {
    // A proxy or another layer can answer 403 with its own JSON. It is no answer to the question.
    reply = () => json({ outcome: "refused" }, 403);
    await expect(new LiveHarbor("shop").decide("at_1", { approvalId: "ap_1", answer: "approve" })).rejects.toBeInstanceOf(ApiError);
  });
});
