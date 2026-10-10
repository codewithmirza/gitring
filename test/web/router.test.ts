import { beforeAll, describe, expect, it } from "vitest";

// The router reads the address of the page; give it one.
beforeAll(() => {
  (globalThis as { location?: unknown }).location = { pathname: "/overview", search: "?project=shop", hash: "" };
});

describe("routes", async () => {
  const { parseRoute, codeHref, href, isProjectRoute, canonicalPath } = await import("../../web/src/app/router");

  it("parses the code view with a ref and a file path", () => {
    expect(parseRoute("/code")).toEqual({ name: "code", ref: undefined, path: undefined });
    expect(parseRoute("/code/main")).toEqual({ name: "code", ref: "main", path: undefined });
    expect(parseRoute("/code/at_1/src/render/header.js")).toEqual({ name: "code", ref: "at_1", path: "src/render/header.js" });
    expect(parseRoute("/code/main/src/a%20b.js")).toEqual({ name: "code", ref: "main", path: "src/a b.js" });
  });

  it("parses the account page and keeps the old aliases", () => {
    expect(parseRoute("/account")).toEqual({ name: "account" });
    expect(parseRoute("/intents/x")).toEqual({ name: "intents", id: "x" });
    expect(canonicalPath("/logbook/l1")).toBe("/history/l1");
    expect(parseRoute("/nope").name).toBe("notfound");
  });

  it("knows which views need a project", () => {
    expect(isProjectRoute({ name: "code" })).toBe(true);
    expect(isProjectRoute({ name: "account" })).toBe(false);
    expect(isProjectRoute({ name: "home" })).toBe(false);
  });

  it("builds code links with a diff and a line", () => {
    expect(codeHref()).toBe("/code/main");
    expect(codeHref("at_1", "src/a b.js", { diff: true })).toBe("/code/at_1/src/a%20b.js?view=diff");
    expect(codeHref("main", "src/x.js", { line: 12, endLine: 20 })).toBe("/code/main/src/x.js#L12-L20");
  });

  it("keeps ?project= and the hash in app links", () => {
    expect(href("/tasks")).toBe("/tasks?project=shop");
    expect(href("/account#keys")).toBe("/account?project=shop#keys");
    expect(href("/code/main/a.js?view=diff#L3")).toBe("/code/main/a.js?view=diff&project=shop#L3");
    expect(href("/overview?project=other")).toBe("/overview?project=other");
  });
});
