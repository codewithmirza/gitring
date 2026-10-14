/**
 * The other ways to sign in: Google and GitHub, and the GitHub connection for repositories.
 * The GitHub connection imports repositories and sends merged code back.
 */
import { Button, InlineConfirm } from "../../design/components";
import { Icon } from "../../design/icons";
import { GitHubMark, GoogleG } from "../../design/brand/marks";
import { useMe } from "../../state/account";
import { connectGithub, disconnectGithub } from "../../state/connections";
import { lastProvider } from "../../app/Account";
import { orderedProviders } from "../../state/signin";

/** The outside sign-ins: only the providers that this gitring has, or that the person used before. */
export function SignInMethods() {
  const me = useMe();
  if (!me?.user) return null;
  const u = me.user;
  const gh = u.identities.find((i) => i.provider === "github");
  const gg = u.identities.find((i) => i.provider === "google");
  const conn = me.github;
  const install = me.githubInstallUrl;
  const here = `${location.pathname}${location.search}`;
  const shown = orderedProviders({ github: Boolean(gh) || me.providers.github, google: Boolean(gg) || me.providers.google }, lastProvider());
  if (!shown.length) return null;
  const rows = {
    github: (
      <li className="acct-row" key="github">
        <span className="acct-row__mark acct-row__mark--github">
          <GitHubMark size={20} />
        </span>
        <div className="acct-row__text">
          <span className="acct-row__name">GitHub</span>
          <span className="acct-row__meta">
            {gh ? `Signed in as @${gh.login}.` : "Not used for sign-in."}{" "}
            {conn?.connected
              ? `gitring can list your repositories${conn.login ? ` as @${conn.login}` : ""} and send merged code back.`
              : conn?.reason
                ? conn.reason
                : gh
                  ? "Connect GitHub to import repositories and send merged code back."
                  : ""}
          </span>
        </div>
        <div className="acct-row__acts">
          {conn?.connected ? (
            <>
              {install && (
                <a className="b-btn b-btn--ghost b-btn--sm" href={install} target="_blank" rel="noopener noreferrer">
                  <Icon name="external" />
                  Add repositories on GitHub
                </a>
              )}
              <InlineConfirm
                label="Disconnect"
                ariaLabel="Disconnect GitHub"
                consequence="gitring forgets the GitHub token. Sign-in with GitHub still works."
                confirmLabel="Disconnect"
                onConfirm={() => disconnectGithub()}
              />
            </>
          ) : (
            me.providers.github && (
              <Button size="sm" variant={gh ? "primary" : "secondary"} onClick={() => connectGithub(here)}>
                {gh ? "Connect GitHub" : "Add GitHub"}
              </Button>
            )
          )}
        </div>
      </li>
    ),
    google: (
      <li className="acct-row" key="google">
        <span className="acct-row__mark">
          <GoogleG size={20} />
        </span>
        <div className="acct-row__text">
          <span className="acct-row__name">Google</span>
          <span className="acct-row__meta">
            {gg ? `Signed in as ${gg.email}.` : me.providers.google ? "Add a Google sign-in to this account." : "Not set up on this server."}
          </span>
        </div>
        <div className="acct-row__acts">
          {!gg && me.providers.google && (
            <Button size="sm" onClick={() => (location.href = `/auth/google/start?link=1&return=${encodeURIComponent(here)}`)}>
              Add Google
            </Button>
          )}
        </div>
      </li>
    ),
  };
  return (
    <section className="acct-sec" aria-labelledby="acct-signin">
      <div className="acct-sec__head">
        <h2 className="page__h2" id="acct-signin">
          Other sign-in methods
        </h2>
        <p className="acct-sec__lede">You can also sign in to gitring with these accounts. gitring keeps the name, email and avatar that they send.</p>
      </div>
      <ul className="acct-rows" role="list">
        {shown.map((p) => rows[p])}
      </ul>
    </section>
  );
}
