/**
 * The whole app of a person that the waitlist gate keeps out.
 * Nothing else of gitring shows. A visitor sees the landing page and the sign-in step. A signed-in person sees the interest page.
 */
import { useEffect } from "react";
import { Button } from "../../design/components";
import { Mark } from "../../design/icons";
import { useStore } from "../../state/store";
import { signOut } from "../../state/account";
import { setSearchParam, useSearchParam } from "../../app/router";
import { LANDING } from "./copy";
import { Interest } from "./Interest";
import { JoinStep, Landing, signInErrorText } from "./Landing";
import "./waitlist.css";

export function Waitlist() {
  const me = useStore((s) => s.me);
  const user = me?.user ?? null;
  const entry = me?.waitlist?.entry ?? null;
  const joining = useSearchParam("join") === "1";
  const errorCode = useSearchParam("signin_error");

  useEffect(() => {
    document.title = user ? "Pick your pack · gitring" : "gitring · Many agents, one codebase";
  }, [user]);
  // The reason of a failed sign-in shows once: the address does not keep it.
  const error = signInErrorText(errorCode);
  useEffect(() => {
    if (errorCode) {
      setSearchParam("signin_error", null);
      setSearchParam("provider", null);
      setSearchParam("join", "1");
    }
  }, [errorCode]);

  return (
    <div className="wl">
      <a href="#wl-main" className="skip-link">
        Skip to the content
      </a>
      <header className="wl-bar">
        <a className="wl-brand" href="/" aria-label="gitring">
          <Mark size={22} />
          <span>gitring</span>
        </a>
        {user && (
          <span className="wl-who">
            <span className="wl-muted">{user.name}</span>
            <Button size="sm" variant="ghost" onClick={() => void signOut()}>
              Sign out
            </Button>
          </span>
        )}
      </header>
      <main id="wl-main" className="wl-main">
        {user ? <Interest entry={entry} /> : joining || error ? <JoinStep error={error} onBack={() => setSearchParam("join", null)} /> : <Landing onJoin={() => setSearchParam("join", "1")} />}
      </main>
      <footer className="wl-foot">
        <span>{LANDING.footer}</span>
        <span>
          <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a>
        </span>
      </footer>
    </div>
  );
}
