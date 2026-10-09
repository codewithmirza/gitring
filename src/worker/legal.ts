/**
 * Privacy policy and terms of this deployment (linked from the Google consent screen).
 * The texts describe what the code does: keep them true when the data model changes.
 * `contact` is HTML (already escaped), from the optional GITRING_CONTACT variable.
 */

const UPDATED = "9 October 2026";

function contactLine(contact: string | null): string {
  return contact ? `Contact: ${contact}.` : "Contact the owner of this deployment.";
}

export function privacyBody(contact: string | null): string {
  return `<h1>Privacy</h1><p class="muted">What this gitring deployment keeps about you, and why. Updated ${UPDATED}.</p>
<div class="card"><h2>Who runs it</h2><p>The owner of this deployment runs gitring on Cloudflare Workers. ${contactLine(contact)}</p></div>
<div class="card"><h2>What gitring keeps</h2><ul>
<li><b>Your account.</b> When you sign in with GitHub or Google, gitring keeps your account id at that provider, your name, your email address, the address of your profile picture and, for GitHub, your login. gitring uses them to sign you in, to show who did what, and to give you access to your projects. gitring does not keep the provider's access tokens.</li>
<li><b>Your session.</b> One cookie keeps you signed in for at most 30 days. gitring keeps only a hash of it. gitring uses no advertising or tracking cookies.</li>
<li><b>API keys.</b> gitring keeps a hash of each key, its name and its first characters. It cannot show a key again.</li>
<li><b>Your projects.</b> Code, intents, course checks, logbook entries and check output stay in Cloudflare (Artifacts and Durable Objects). Anyone can see a public project. Only members can see a private project.</li>
</ul></div>
<div class="card"><h2>Who else processes it</h2><ul>
<li><b>Cloudflare</b> hosts gitring and runs its AI models (Workers AI) and check containers. Built-in agents and course checks send project text to these models.</li>
<li><b>GitHub and Google</b> confirm who you are when you sign in.</li>
</ul><p>gitring does not sell your data and shows no advertising.</p></div>
<div class="card"><h2>Google user data</h2><p>gitring asks Google only for your account id, name, email address and profile picture (scopes <code>openid</code>, <code>email</code>, <code>profile</code>), and uses them only to sign you in and to show your name. gitring's use of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements.</p></div>
<div class="card"><h2>Your choices</h2><p>Revoke API keys and remove projects that you own in gitring. To delete your account and its data, ask the owner of this deployment. ${contactLine(contact)}</p>
<p><a class="btn secondary" href="/terms">Terms</a> <a class="btn" href="/">Open gitring</a></p></div>`;
}

export function termsBody(contact: string | null): string {
  return `<h1>Terms</h1><p class="muted">The rules for this gitring deployment. Updated ${UPDATED}.</p>
<div class="card"><ul>
<li>gitring is open-source software. This deployment is given "as is", without warranty of any kind, and it can change or stop at any time.</li>
<li>Put in gitring only code and text that you have the right to share. Do not put secrets in projects.</li>
<li>AI agents can make mistakes. gitring lands work only when its checks pass, but you are responsible for the code that you use.</li>
<li>Do not use gitring to attack, overload or abuse other systems. The owner can remove projects and accounts that break these terms.</li>
</ul><p>${contactLine(contact)}</p>
<p><a class="btn secondary" href="/privacy">Privacy</a> <a class="btn" href="/">Open gitring</a></p></div>`;
}
