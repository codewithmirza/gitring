/**
 * The connector section: the steps to add gitring to an agent app by OAuth, and the live status.
 * The status polls every 5 s only while the tab is visible and no app is connected yet.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Button, CodeBlock, Tabs, TabPanel } from "../../design/components";
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
import { GITHUB_SWAP, MERGE_QUESTION, READ_ONLY, TOOLS, mcpEndpoints } from "../connect-text";
import { type Client, CLIENT_IDS, clientName, CLIENTS, cursorLink } from "./clients";
import { CopyField, Inline, useRemembered } from "./shared";

const NO_AGENTS: AgentInfo[] = [];

/* ───────────── parts of the section ───────────── */

/** "Not yet linked" until an app signs in through OAuth; then the apps and the agents that work here. */
function LiveStatus({ client }: { client: Client }) {
  const me = useMe();
  const signedIn = Boolean(me?.user);
  const agents = useStore((s) => s.state?.agents ?? NO_AGENTS);
  const outside = useMemo(() => agents.filter((a) => a.kind === "mcp").sort((a, b) => b.lastSeen - a.lastSeen).slice(0, 3), [agents]);
  const [grants, setGrants] = useState<OAuthGrantInfo[] | null>(null);
  const [missing, setMissing] = useState(false);
  const now = useNow(15_000);

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
                  <strong>{g.clientName}</strong> is connected{g.lastUsedAt ? ` · used ${ago(g.lastUsedAt, now)}` : ` · allowed ${ago(g.createdAt, now)}`}
                </li>
              ))}
              {outside.map((a) => (
                <li key={a.id}>
                  <strong>{clientName(a)}</strong> worked on this project {ago(a.lastSeen, now)}
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
                <strong>{clientName(a)}</strong> worked on this project {ago(a.lastSeen, now)}
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

function Step({ children }: { children: ReactNode }) {
  return <li>{children}</li>;
}

/** Scroll to a section of this page and put the focus on its heading. */
function jumpTo(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  el.setAttribute("tabindex", "-1");
  el.focus({ preventScroll: true });
}

/**
 * Under the connector: what happens when an agent asks for a merge, and two other addresses. Both
 * addresses are closed at first: the main path stays one URL and the agent tabs.
 */
function AfterConnect({ endpoints }: { endpoints: ReturnType<typeof mcpEndpoints> }) {
  return (
    <div className="cx-after">
      <h3 className="cx-after__title" id="cx-ask">
        {MERGE_QUESTION.title}
      </h3>
      <ul className="cx-lines" aria-labelledby="cx-ask">
        <li>
          {MERGE_QUESTION.lines[0]} {MERGE_QUESTION.settings} <Link to="/settings?section=merging">{MERGE_QUESTION.settingsLink}</Link>.
        </li>
        <li>{MERGE_QUESTION.lines[1]}</li>
        <li>
          {MERGE_QUESTION.lines[2]} {MERGE_QUESTION.slack}{" "}
          <a
            href="#cx-out"
            onClick={(e) => {
              e.preventDefault();
              jumpTo("cx-out");
            }}
          >
            {MERGE_QUESTION.slackLink}
          </a>
          .
        </li>
      </ul>
      <details className="cx-more" id="cx-github-swap">
        <summary>{GITHUB_SWAP.summary}</summary>
        <div className="cx-more__body">
          <CopyField value={endpoints.github} label={GITHUB_SWAP.label} variant="secondary" />
          <ul className="cx-lines">
            {GITHUB_SWAP.lines.map((line) => (
              <li key={line}>
                <Inline text={line} />
              </li>
            ))}
          </ul>
        </div>
      </details>
      <details className="cx-more" id="cx-readonly">
        <summary>{READ_ONLY.summary}</summary>
        <div className="cx-more__body">
          <CopyField value={endpoints.readonly} label={READ_ONLY.label} variant="secondary" />
          <p className="cx__step">
            <Inline text={READ_ONLY.text} />
          </p>
        </div>
      </details>
    </div>
  );
}

/* ───────────── the section ───────────── */

export function ConnectorSection({ mcpUrl }: { mcpUrl: string }) {
  const [client, setClient] = useRemembered<Client>("gitring.connect.client", "claude", CLIENT_IDS);
  const cursorJson = JSON.stringify({ mcpServers: { gitring: { url: mcpUrl } } }, null, 2);
  const endpoints = mcpEndpoints(mcpUrl);
  return (
    <section className="cx-hero" aria-labelledby="cx-connector">
      <div className="cx-hero__text">
        <h2 className="page__h2" id="cx-connector">
          Add gitring as a connector
        </h2>
        <p>One URL for every agent. Your agent signs in with your gitring account (OAuth), so you do not copy a key.</p>
      </div>
      <CopyField value={mcpUrl} label="MCP URL" />
      <Tabs<Client> label="Your agent" idPrefix="cxc" value={client} onChange={setClient} tabs={CLIENTS} />
      <TabPanel idPrefix="cxc" id="claude" active={client === "claude"} className="cx__panel">
        <ol className="cx-steps">
          <Step>Copy the URL.</Step>
          <Step>
            In Claude, open <strong>Settings → Connectors</strong>, then click <strong>Add custom connector</strong>.{" "}
            <a href="https://claude.ai/settings/connectors" target="_blank" rel="noopener noreferrer">
              Open Claude settings <Icon name="external" size={12} className="cx-ext" />
            </a>
          </Step>
          <Step>
            Name it <span className="code-inline">gitring</span>, paste the URL and click <strong>Add</strong>. Then click <strong>Connect</strong>.
          </Step>
          <Step>
            gitring asks you to allow Claude. Click <strong>Allow</strong>. Claude can now read your projects, send plans and push work in any chat.
          </Step>
        </ol>
        <p className="cx__note">
          <Icon name="info" size={12} />
          <span>On Team and Enterprise plans, an owner adds the connector in Organization settings → Connectors.</span>
        </p>
      </TabPanel>
      <TabPanel idPrefix="cxc" id="claude-code" active={client === "claude-code"} className="cx__panel">
        <CodeBlock shell label="Terminal" code={`claude mcp add --transport http --scope user gitring ${mcpUrl}`} />
        <ol className="cx-steps" start={2}>
          <Step>
            In Claude Code, type <span className="code-inline">/mcp</span>, choose <strong>gitring</strong>, then <strong>Authenticate</strong>.
          </Step>
          <Step>
            Your browser opens gitring. Click <strong>Allow</strong>.
          </Step>
        </ol>
        <p className="cx__note">
          <Icon name="info" size={12} />
          <span>Optional: add the Claude Code hook (below). Then change requests also arrive in the middle of a task.</span>
        </p>
      </TabPanel>
      <TabPanel idPrefix="cxc" id="cursor" active={client === "cursor"} className="cx__panel">
        <div className="cx-row">
          <a className="b-btn b-btn--primary cx-cursor" href={cursorLink(mcpUrl)}>
            <Icon name="plus" />
            Add to Cursor
          </a>
          <span className="cx__step">Cursor opens and asks to install gitring.</span>
        </div>
        <ol className="cx-steps" start={2}>
          <Step>
            In Cursor, open <strong>Settings → MCP</strong> and click <strong>Login</strong> next to gitring.
          </Step>
          <Step>
            Your browser opens gitring. Click <strong>Allow</strong>.
          </Step>
        </ol>
        <details className="cx-more">
          <summary>Add it by hand</summary>
          <CodeBlock label="~/.cursor/mcp.json" code={cursorJson} copyLabel="Copy config" />
        </details>
      </TabPanel>
      <TabPanel idPrefix="cxc" id="codex" active={client === "codex"} className="cx__panel">
        <CodeBlock shell label="Terminal" code={`codex mcp add gitring --url ${mcpUrl}\ncodex mcp login gitring`} />
        <ol className="cx-steps" start={2}>
          <Step>
            The second command opens your browser. Click <strong>Allow</strong>.
          </Step>
        </ol>
        <p className="cx__note">
          <Icon name="info" size={12} />
          <span>In the Codex app: Settings → MCP servers → Add server, then paste the URL.</span>
        </p>
      </TabPanel>
      <TabPanel idPrefix="cxc" id="other" active={client === "other"} className="cx__panel">
        <p className="cx__step">
          Any MCP client with OAuth 2.1 can connect: streamable HTTP at the URL above, with dynamic client registration and PKCE. The client finds the gitring sign-in by
          itself in the metadata at <span className="code-inline">/.well-known/oauth-protected-resource</span>.
        </p>
        <p className="cx__step">
          A client without OAuth sends a personal API key in the header <span className="code-inline">Authorization: Bearer gk_…</span>. See{" "}
          <a
            href="#cx-keys"
            onClick={(e) => {
              e.preventDefault();
              jumpTo("cx-keys");
            }}
          >
            Use an API key instead
          </a>
          .
        </p>
        <ul className="tools" aria-label="The gitring tools">
          {TOOLS.map(([t, d]) => (
            <li key={t}>
              <span className="voice-agent">{t}</span>
              <span>{d}</span>
            </li>
          ))}
        </ul>
      </TabPanel>
      <LiveStatus client={client} />
      <AfterConnect endpoints={endpoints} />
    </section>
  );
}
