/** Privacy and terms pages: the Google consent screen links to them. */
import { describe, expect, it } from "vitest";
import { privacyBody, termsBody } from "../../src/worker/legal";

describe("privacy and terms", () => {
  it("names the contact, or the owner when no contact is set", () => {
    expect(privacyBody('<a href="mailto:help@example.com">help@example.com</a>')).toContain('Contact: <a href="mailto:help@example.com">');
    expect(privacyBody(null)).toContain("Contact the owner of this deployment.");
    expect(termsBody(null)).toContain("Contact the owner of this deployment.");
  });

  it("states the Google scopes, Limited Use and that no provider tokens are kept", () => {
    const p = privacyBody(null);
    expect(p).toContain("<code>openid</code>, <code>email</code>, <code>profile</code>");
    expect(p).toContain("Limited Use");
    expect(p).toContain("does not keep the provider's access tokens");
  });

  it("links the two pages to each other", () => {
    expect(privacyBody(null)).toContain('href="/terms"');
    expect(termsBody(null)).toContain('href="/privacy"');
  });
});
