/**
 * The live line under the agent choice: "gitring waits for your agent", then the apps that are connected.
 * It asks the server every 5 s only while the tab is visible and no app is connected yet (for 10 minutes at most).
 * It never shows a code name. Read next: ConnectorSection.tsx (the part that shows it).
 */
import { useEffect, useMemo, useState } from "react";
import { Button } from "../../design/components";
import type { AgentInfo } from "../../../../src/core/types";
import type { OAuthGrantInfo } from "../../../../src/core/accounts";
import { useMe } from "../../state/account";
import { isAbort, listGrants, RequestError } from "../../state/github";
import { openSignIn } from "../../app/ui";
import { Link } from "../../app/router";
import { useNow } from "../../app/useNow";
import { Icon } from "../../design/icons";
import { ago } from "../../state/format";
import { useStore } from "../../state/store";
import { type Client, clientName, CLIENTS } from "./clients";

const NO_AGENTS: AgentInfo[] = [];

/** The apps that signed in through OAuth. It polls only while none is connected and the tab shows. */
function useGrants(signedIn: boolean) {
  const [grants, setGrants] = useState<OAuthGrantInfo[] | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (!signedIn) return;
    const ctl = new AbortController();
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const tick = async () => {
      clearTimeout(timer);
      if (stopped || document.visibilityState !== "visible") return;
      try {
        const list = await listGrants(ctl.signal);
        setGrants(list);
        setMissing(false);
        if (list.length) return; // connected: no more polling (a visit back to the tab looks once more)
      } catch (e) {
        if (isAbort(e)) return;
        // No such endpoint, or no session: stop asking.
        if (e instanceof RequestError && (e.status === 404 || e.status === 401 || e.status === 403)) {
          setMissing(true);
          return;
        }
      }
      if (Date.now() - started < 10 * 60_000) timer = setTimeout(() => void tick(), 5000);
    };
    const onVis = () => {
      if (document.visibilityState === "visible") void tick();
    };
    void tick();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stopped = true;
      clearTimeout(timer);
      ctl.abort();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [signedIn]);
  return { grants, missing };
}

/** "Not yet linked" until an app signs in through OAuth; then the apps and the agents that work here. */
export function LiveStatus({ client }: { client: Client }) {
  const me = useMe();
  const signedIn = Boolean(me?.user);
  const agents = useStore((s) => s.state?.agents ?? NO_AGENTS);
  const outside = useMemo(() => agents.filter((a) => a.kind === "mcp").sort((a, b) => b.lastSeen - a.lastSeen).slice(0, 3), [agents]);
  const { grants, missing } = useGrants(signedIn);
  const now = useNow(15_000);

  const want = CLIENTS.find((c) => c.id === client)?.label ?? "your agent";
  const connected = (grants ?? []).slice().sort((a, b) => (b.lastUsedAt ?? b.createdAt) - (a.lastUsedAt ?? a.createdAt));

  if (!signedIn) {
    return (
      <div className="cx-live" role="status">
        <Icon name="human" size={14} className="cx-live__icon" />
        <span className="cx-live__text">Sign in first. Your agent then signs in as you.</span>
        <Button size="sm" variant="primary" onClick={openSignIn}>
          Sign in
        </Button>
      </div>
    );
  }
  return (
    <div className="cx-live" role="status" aria-live="polite">
      {connected.length > 0 ? (
        <>
          <Icon name="check" size={14} className="cx-live__icon cx-live__icon--ok" />
          <div className="cx-live__text">
            <ul className="cx-live__list">
              {connected.slice(0, 4).map((g) => (
                <li key={g.id}>
                  <strong>{g.clientName}</strong> is connected. {g.lastUsedAt ? `Last used ${ago(g.lastUsedAt, now)}.` : `Allowed ${ago(g.createdAt, now)}.`}
                </li>
              ))}
              {outside.map((a) => (
                <li key={a.id}>
                  <strong>{clientName(a)}</strong> worked on this project {ago(a.lastSeen, now)}.
                </li>
              ))}
            </ul>
            <Link to="/account" className="cx-live__more">
              See or revoke connected apps
            </Link>
          </div>
        </>
      ) : outside.length > 0 ? (
        <>
          <Icon name="check" size={14} className="cx-live__icon cx-live__icon--ok" />
          <ul className="cx-live__list cx-live__text">
            {outside.map((a) => (
              <li key={a.id}>
                <strong>{clientName(a)}</strong> worked on this project {ago(a.lastSeen, now)}.
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <span className="cx-live__wait" aria-hidden="true" />
          <span className="cx-live__text">
            {grants === null && !missing ? "gitring looks for connected agents…" : `gitring waits for ${want}. This line changes when your agent signs in.`}
          </span>
        </>
      )}
    </div>
  );
}
