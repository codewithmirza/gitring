/** Privacy and terms pages: the Google consent screen links to them. */
import { describe, expect, it } from "vitest";
import { privacyBody, termsBody } from "../../src/worker/legal";
import { steViolations } from "../coord/ste";

describe("privacy and terms", () => {
  it("names the contact, or the owner when no contact is set", () => {
    expect(privacyBody('<a href="mailto:help@example.com">help@example.com</a>')).toContain('Contact: <a href="mailto:help@example.com">');
    expect(privacyBody(null)).toContain("Contact the owner of this deployment.");
    expect(termsBody(null)).toContain("Contact the owner of this deployment.");
  });

  it("states the Google scopes, Limited Use, and how the GitHub token is kept", () => {
    const p = privacyBody(null);
    expect(p).toContain("<code>openid</code>, <code>email</code>, <code>profile</code>");
    expect(p).toContain("Limited Use");
    expect(p).toContain("does not keep Google's access tokens");
    expect(p).toContain("encrypted (AES-GCM)");
    expect(p).toContain("Connected apps");
    // A passkey stays on the device: gitring keeps the public key only.
    expect(p).toContain("gitring keeps its public key");
    // The passkey item and the cookie sentences follow the STE rules.
    const passkeys = /<li><b>Your passkeys\.<\/b> ([^<]+)<\/li>/.exec(p)![1];
    const cookies = "A second cookie (at most 15 minutes) ties a sign-in to your browser. One more cookie remembers which way you used last.";
    expect(p).toContain(cookies);
    for (const m of [passkeys, cookies]) expect(steViolations(m), m).toEqual([]);
  });

  it("links the two pages to each other", () => {
    expect(privacyBody(null)).toContain('href="/terms"');
    expect(termsBody(null)).toContain('href="/privacy"');
  });
});
