/**
 * "/" — the start page. Visitors read what gitring is, how it works and how to add it to their agent as an
 * MCP connector, then sign in. Signed-in people go to their remembered project, else their first project,
 * else to their projects. With "/?home" they can read this page too.
 */
import { useEffect, useState, type CSSProperties } from "react";
import type { ProjectInfo } from "../../../src/core/accounts";
import { Button, CodeBlock, SkeletonPage, Tabs, TabPanel } from "../design/components";
import { Mark } from "../design/icons";
import { useStore } from "../state/store";
import { rememberedProject } from "../state/account";
import { Link, navigate, useSearchParam } from "../app/router";
import { openSignIn } from "../app/ui";
import { copyMcpUrl, mcpUrl } from "../app/actions";
import "./home.css";

const STEPS: { title: string; text: string }[] = [
  { title: "You write a task.", text: "A task has a goal. You can add test files that prove it." },
  {
    title: "An agent sends its plan.",
    text: "The plan lists the files and functions that the agent will change. Agents connect through MCP: Claude, Claude Code, Codex, Cursor, or the built-in agents.",
  },
  {
    title: "gitring checks the plan.",
    text: "gitring compares the plan with the 20 nearest active plans and with main. If two agents will collide, one agent gets a change request. The other agent continues.",
  },
  {
    title: "gitring merges the work.",
    text: "When the tests pass, gitring merges the work into main: fast-forward, 3-way merge, or a redo on the new main. A person says yes first when the project asks. Each merge keeps a record of why.",
  },
];

type Client = "claude" | "claude-code" | "cursor" | "codex" | "other";
const CLIENT_KEY = "gitring.client";

function readClient(): Client {
  try {
    const v = localStorage.getItem(CLIENT_KEY);
    return v === "claude" || v === "claude-code" || v === "cursor" || v === "codex" || v === "other" ? v : "claude";
  } catch {
    return "claude";
  }
}

/** The person's project for "/": the remembered one, else the first they own, else the first they are a member of. */
export function homeProject(projects: ProjectInfo[], asked: string | null, loaded: string | null): string | null {
  const ids = new Set(projects.map((p) => p.id));
  if (asked && ids.has(asked)) return asked;
  if (loaded && ids.has(loaded)) return loaded;
  const remembered = rememberedProject();
  if (remembered && ids.has(remembered)) return remembered;
  return projects.find((p) => p.role === "owner")?.id ?? projects.find((p) => p.role === "member")?.id ?? null;
}

/** Two agents work at the same time; one gets a change request; both merge into main when the tests pass. */
function HeroArt() {
  const lane = (n: number) => ({ "--vc": `var(--v${n})` }) as CSSProperties;
  return (
    <svg className="home__art" viewBox="0 0 560 150" role="img" aria-labelledby="home-art-title">
      <title id="home-art-title">
        Two agents work on one codebase at the same time. gitring sends one agent a change request. The work of both agents merges into main when the tests
        pass.
      </title>
      <path className="home__lane" style={lane(2)} d="M56 118 C 80 118, 80 34, 104 34 H 418 C 442 34, 446 118, 470 118" />
      <path className="home__lane" style={lane(0)} d="M98 118 C 118 118, 118 76, 138 76 H 258 C 278 76, 282 118, 302 118" />
      <line className="home__main" x1="20" y1="118" x2="540" y2="118" />
      {[28, 56, 98, 540].map((x) => (
        <circle key={x} className="home__dot home__dot--main" cx={x} cy={118} r={4} />
      ))}
      {[150, 214].map((x) => (
        <circle key={x} className="home__dot" style={lane(0)} cx={x} cy={76} r={4} />
      ))}
      {[136, 330, 388].map((x) => (
        <circle key={x} className="home__dot" style={lane(2)} cx={x} cy={34} r={4} />
      ))}
      <path className="home__marker" d="M250 26 L258 34 L250 42 L242 34 Z" />
      <text className="home__artlabel home__artlabel--cr" x={250} y={16} textAnchor="middle">
        change request
      </text>
      <text className="home__artlabel" x={150} y={62}>
        agent 1
      </text>
      <text className="home__artlabel" x={136} y={20} textAnchor="middle">
        agent 2
      </text>
      {[302, 470].map((x) => (
        <g key={x} transform={`translate(${x} 118)`}>
          <circle className="home__merge" r={8} />
          <path className="home__check" d="M-3.5 0.5 L-1 3 L4 -2.5" />
        </g>
      ))}
      <text className="home__artlabel home__artlabel--ok" x={386} y={144} textAnchor="middle">
        tests pass · merged into main
      </text>
      <text className="home__artlabel" x={20} y={144}>
        main
      </text>
    </svg>
  );
}

function cursorLink(url: string): string {
  const config = btoa(JSON.stringify({ url }));
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=gitring&config=${encodeURIComponent(config)}`;
}

/** How to add gitring to an agent as an MCP connector. OAuth: no key to copy. */
function ConnectorSteps({ signedIn }: { signedIn: boolean }) {
  const [client, setClientState] = useState<Client>(readClient);
  const url = mcpUrl();
  const setClient = (c: Client) => {
    setClientState(c);
    try {
      localStorage.setItem(CLIENT_KEY, c);
    } catch {
      /* storage off */
    }
  };
  return (
    <div className="home__connect">
      <div className="home__url">
        <span className="home__urllabel">MCP URL</span>
        <code className="home__urlvalue">{url}</code>
        <Button size="sm" icon="copy" onClick={() => void copyMcpUrl()}>
          Copy URL
        </Button>
      </div>
      <Tabs<Client>
        label="Your agent"
        idPrefix="home-client"
        value={client}
        onChange={setClient}
        tabs={[
          { id: "claude", label: "Claude" },
          { id: "claude-code", label: "Claude Code" },
          { id: "cursor", label: "Cursor" },
          { id: "codex", label: "Codex" },
          { id: "other", label: "Other" },
        ]}
      />
      <TabPanel idPrefix="home-client" id="claude" active={client === "claude"} className="home__panel">
        <ol className="home__list">
          <li>Copy the URL.</li>
          <li>In Claude, open Settings, then Connectors. Select Add custom connector.</li>
          <li>Paste the URL. Select Add, then Connect.</li>
          <li>gitring asks you to allow Claude. Select Allow.</li>
        </ol>
        <p className="home__text home__text--sm">Team owners add it once for everyone in Organization settings, then Connectors.</p>
      </TabPanel>
      <TabPanel idPrefix="home-client" id="claude-code" active={client === "claude-code"} className="home__panel">
        <CodeBlock shell label="Terminal" code={`claude mcp add --transport http --scope user gitring ${url}`} />
        <p className="home__text home__text--sm">
          Then type <span className="code-inline">/mcp</span> in Claude Code, select gitring and sign in. Your browser opens once.
        </p>
      </TabPanel>
      <TabPanel idPrefix="home-client" id="cursor" active={client === "cursor"} className="home__panel">
        <div className="home__row">
          <a className="b-btn b-btn--primary" href={cursorLink(url)}>
            Add to Cursor
          </a>
          <span className="home__text home__text--sm">Cursor opens, adds gitring and asks you to sign in.</span>
        </div>
        <CodeBlock label="Or add it to .cursor/mcp.json" code={JSON.stringify({ mcpServers: { gitring: { url } } }, null, 2)} copyLabel="Copy config" />
      </TabPanel>
      <TabPanel idPrefix="home-client" id="codex" active={client === "codex"} className="home__panel">
        <CodeBlock shell label="Terminal" code={`codex mcp add gitring --url ${url}\ncodex mcp login gitring`} />
        <p className="home__text home__text--sm">In the Codex app: Settings, then MCP servers, then Add server. Paste the URL.</p>
      </TabPanel>
      <TabPanel idPrefix="home-client" id="other" active={client === "other"} className="home__panel">
        <p className="home__text home__text--sm">
          Add the URL to any MCP client that supports OAuth. It opens your browser, you sign in, and you allow it. Clients without OAuth, scripts and hooks
          send the header <span className="code-inline">Authorization: Bearer gk_…</span> with a personal API key
          {signedIn ? (
            <>
              {" "}
              from <Link to="/account#keys">Account, API keys</Link>.
            </>
          ) : (
            " from your account."
          )}
        </p>
      </TabPanel>
    </div>
  );
}

export function HomeView() {
  const accountReady = useStore((s) => s.accountReady);
  const signedIn = useStore((s) => Boolean(s.me?.user));
  const projects = useStore((s) => s.projects);
  const loaded = useStore((s) => (s.state ? s.projectId : null));
  const stay = useSearchParam("home") !== null;
  const asked = useSearchParam("project");
  const leave = accountReady && signedIn && !stay;

  useEffect(() => {
    if (!leave) return;
    const id = homeProject(projects, asked, loaded);
    navigate(id ? `/overview?project=${encodeURIComponent(id)}` : "/projects", { replace: true });
  }, [leave, asked, loaded, projects]);

  // "/?home#home-connect" (from the palette or a link) opens at that section.
  useEffect(() => {
    if (!accountReady || leave || !location.hash) return;
    const el = document.getElementById(decodeURIComponent(location.hash.slice(1)));
    el?.scrollIntoView({ block: "start" });
  }, [accountReady, leave]);

  if (!accountReady || leave) return <SkeletonPage label="Please wait" />;

  return (
    <div className="home">
      <section className="home__hero" aria-labelledby="home-title">
        <p className="home__brand">
          <Mark size={20} />
          gitring
        </p>
        <h1 className="home__title" id="home-title" tabIndex={-1}>
          Many agents. One codebase. No merge fights.
        </h1>
        <p className="home__lede">
          gitring checks the plan of each agent before it writes code. It sends a change request instead of a rejection. It merges work only when the tests
          pass, and it asks you before risky work.
        </p>
        <div className="home__actions">
          {signedIn ? (
            <Button variant="primary" icon="grid" onClick={() => navigate("/projects")}>
              Open your projects
            </Button>
          ) : (
            <Button variant="primary" onClick={(e) => openSignIn({ anchor: e.currentTarget })} aria-haspopup="dialog">
              Sign in
            </Button>
          )}
          <a className="b-btn b-btn--secondary" href="#home-connect">
            Add gitring to your agent
          </a>
        </div>
        <figure className="home__figure">
          <HeroArt />
        </figure>
      </section>

      <section className="home__sec" aria-labelledby="home-how">
        <h2 className="home__h2" id="home-how">
          How it works
        </h2>
        <ol className="home__steps">
          {STEPS.map((s, i) => (
            <li key={s.title} className="home__step">
              <span className="home__num voice-agent" aria-hidden="true">
                {i + 1}
              </span>
              <div>
                <h3 className="home__h3">{s.title}</h3>
                <p className="home__text">{s.text}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="home__sec" aria-labelledby="home-connect-title" id="home-connect">
        <h2 className="home__h2" id="home-connect-title">
          Add gitring to your agent
        </h2>
        <p className="home__text">
          gitring is an MCP connector. Your agent adds one URL and signs in with your gitring account (OAuth). There is no key to copy. Your agent can then
          create projects, read the open tasks, send its plan and get change requests.
        </p>
        <ConnectorSteps signedIn={signedIn} />
      </section>

      <section className="home__sec" aria-labelledby="home-code">
        <h2 className="home__h2" id="home-code">
          Where your code goes
        </h2>
        <p className="home__text">
          gitring holds the code. Each project is a git repository in Cloudflare Artifacts. Describe a project or start from a template, upload a folder, push
          with git, or import any git URL. An agent creates a project through MCP with one call. GitHub is optional. gitring can import a repository from
          GitHub. It can also send merged code back to GitHub as a pull request, or straight to main.
        </p>
        {!signedIn && (
          <div className="home__actions">
            <Button variant="primary" onClick={(e) => openSignIn({ anchor: e.currentTarget, reason: "Sign in to make your first project.", then: { kind: "newProject" } })}>
              Sign in to make a project
            </Button>
          </div>
        )}
      </section>

      <footer className="home__foot">
        <p className="home__built">Built on Cloudflare: Workers, Durable Objects, Artifacts, Workers AI and Containers.</p>
        <nav className="home__links" aria-label="Legal">
          <a href="/privacy">Privacy</a>
          <a href="/terms">Terms</a>
        </nav>
      </footer>
    </div>
  );
}
