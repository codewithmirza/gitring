/**
 * The page for people who are signed out while the waitlist gate is on. Step 1: what gitring is, what it
 * solves, how it works and the product video. Step 2 ("Join the waitlist"): Continue with Google or GitHub.
 */
import { useEffect, useState } from "react";
import { Button } from "../../design/components";
import { GitHubMark, GoogleG } from "../../design/brand/marks";
import { useStore } from "../../state/store";
import { githubSignInUrl, googleSignInUrl } from "../../state/signin";
import { SignInChoices } from "../../app/Account";
import { JOIN, LANDING, SIGN_IN_ERRORS } from "./copy";
import { PLACEHOLDER_URL, POSTER_URL, VIDEO_URL, videoExists } from "./video";

function ProductVideo() {
  const [state, setState] = useState<"checking" | "yes" | "no">("checking");
  useEffect(() => {
    let live = true;
    void videoExists().then((ok) => live && setState(ok ? "yes" : "no"));
    return () => {
      live = false;
    };
  }, []);
  return (
    <div className="wl-video">
      {state === "yes" ? (
        <video className="wl-video__el" controls preload="metadata" poster={POSTER_URL} aria-label={LANDING.videoLabel} onError={() => setState("no")}>
          <source src={VIDEO_URL} type="video/mp4" />
        </video>
      ) : (
        <div className="wl-video__missing" style={{ backgroundImage: `url(${PLACEHOLDER_URL})` }} role="img" aria-label={LANDING.videoLabel}>
          {state === "no" && <p className="wl-video__note">{LANDING.videoMissing}</p>}
        </div>
      )}
    </div>
  );
}

export function Landing({ onJoin }: { onJoin: () => void }) {
  return (
    <>
      <section className="wl-hero">
        <h1 className="wl-title" tabIndex={-1}>
          {LANDING.title}
        </h1>
        <p className="wl-lede">{LANDING.lede}</p>
        <div className="wl-actions">
          <Button variant="primary" onClick={onJoin}>
            {LANDING.join}
          </Button>
          <span className="wl-muted">{LANDING.closed}</span>
        </div>
      </section>
      <section className="wl-sec" aria-labelledby="wl-video-h">
        <h2 id="wl-video-h" className="wl-h2">
          {LANDING.videoTitle}
        </h2>
        <ProductVideo />
      </section>
      <section className="wl-sec" aria-labelledby="wl-solves-h">
        <h2 id="wl-solves-h" className="wl-h2">
          {LANDING.solvesTitle}
        </h2>
        <ul className="wl-grid">
          {LANDING.solves.map((s) => (
            <li key={s.title} className="wl-card">
              <h3 className="wl-h3">{s.title}</h3>
              <p>{s.text}</p>
            </li>
          ))}
        </ul>
      </section>
      <section className="wl-sec" aria-labelledby="wl-how-h">
        <h2 id="wl-how-h" className="wl-h2">
          {LANDING.howTitle}
        </h2>
        <ol className="wl-steps">
          {LANDING.how.map((s, i) => (
            <li key={s.title} className="wl-step">
              <span className="wl-step__n" aria-hidden="true">
                {i + 1}
              </span>
              <h3 className="wl-h3">{s.title}</h3>
              <p>{s.text}</p>
            </li>
          ))}
        </ol>
        <div className="wl-actions">
          <Button variant="primary" onClick={onJoin}>
            {LANDING.join}
          </Button>
        </div>
      </section>
    </>
  );
}

/** Step 2: sign in with Google or GitHub. */
export function JoinStep({ error, onBack }: { error: string | null; onBack: () => void }) {
  const providers = useStore((s) => s.me?.providers);
  const back = "/";
  const none = providers && !providers.google && !providers.github;
  return (
    <section className="wl-join" aria-labelledby="wl-join-h">
      <h1 id="wl-join-h" className="wl-title wl-title--sm" tabIndex={-1}>
        {JOIN.title}
      </h1>
      <p className="wl-lede">{JOIN.text}</p>
      {error && (
        <p className="wl-error" role="alert">
          {error}
        </p>
      )}
      {none ? (
        <>
          <p className="wl-muted">{JOIN.none}</p>
          <SignInChoices returnTo={back} />
        </>
      ) : (
        <div className="wl-providers">
          {providers?.google && (
            <a className="b-provider" href={googleSignInUrl(back)}>
              <GoogleG size={18} />
              <span className="b-provider__text">{JOIN.google}</span>
            </a>
          )}
          {providers?.github && (
            <a className="b-provider" href={githubSignInUrl(back)}>
              <GitHubMark size={18} />
              <span className="b-provider__text">{JOIN.github}</span>
            </a>
          )}
        </div>
      )}
      <p className="wl-muted">
        {JOIN.keep} <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a>
      </p>
      <p>
        <Button variant="ghost" onClick={onBack}>
          {JOIN.back}
        </Button>
      </p>
    </section>
  );
}

export function signInErrorText(code: string | null): string | null {
  return code ? (SIGN_IN_ERRORS[code] ?? SIGN_IN_ERRORS.failed) : null;
}
