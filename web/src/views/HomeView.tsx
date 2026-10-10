/**
 * "/" — the start page. Visitors read what gitring does and how to begin. Signed-in people go to the
 * overview of their project (or to their projects); with "/?home" they can read this page too.
 */
import { useEffect, type CSSProperties } from "react";
import { Button, CodeBlock, ProgressRule } from "../design/components";
import { Mark } from "../design/icons";
import { useStore } from "../state/store";
import { defaultProjectFor } from "../state/api";
import { Link, navigate, useSearchParam } from "../app/router";
import { setUi } from "../app/ui";
import "./home.css";

const STEPS: { title: string; text: string }[] = [
  { title: "A person writes a task.", text: "A task has a goal. You can add test files." },
  {
    title: "An agent sends its plan.",
    text: "The plan lists the files and functions that the agent will change. Agents connect through MCP: Claude Code, Codex, Cursor, or the built-in agents.",
  },
  {
    title: "gitring checks the plan.",
    text: "gitring compares the plan with all other active work and with main. If two agents will collide, one agent gets a change request. The other agent continues.",
  },
  {
    title: "gitring merges the work.",
    text: "When the tests pass, gitring merges the work into main: fast-forward, 3-way merge, or a redo on the new main. Each merge keeps a record of why.",
  },
];

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

export function HomeView() {
  const accountReady = useStore((s) => s.accountReady);
  const signedIn = useStore((s) => Boolean(s.me?.user));
  const projects = useStore((s) => s.projects);
  const loaded = useStore((s) => (s.state ? s.projectId : null));
  const stay = useSearchParam("home") !== null;
  const asked = useSearchParam("project");
  const leave = accountReady && signedIn && !stay;

  // Signed in: open the project of this person (the one in the address, the open one, the remembered one or their first own).
  useEffect(() => {
    if (!leave) return;
    const id = (asked && projects.some((p) => p.id === asked) ? asked : null) ?? loaded ?? defaultProjectFor(projects);
    navigate(id ? `/overview?project=${encodeURIComponent(id)}` : "/projects", { replace: true });
  }, [leave, asked, loaded, projects]);

  if (!accountReady || leave) {
    return (
      <div className="home home--wait">
        <ProgressRule label="Loading" />
      </div>
    );
  }

  const command = `claude mcp add --transport http gitring ${location.origin}/mcp --header "Authorization: Bearer $GITRING_KEY"`;
  return (
    <div className="home">
      <section className="home__hero" aria-labelledby="home-title">
        <p className="home__brand">
          <Mark size={20} />
          gitring
        </p>
        <h1 className="home__title" id="home-title" tabIndex={-1}>
          Many coding agents. One codebase. No merge fights.
        </h1>
        <p className="home__lede">
          gitring checks the plan of each agent before it writes code. It sends a change request instead of a rejection. It merges work only when the tests
          pass.
        </p>
        <div className="home__actions">
          {signedIn ? (
            <Button variant="primary" icon="grid" onClick={() => navigate("/projects")}>
              Open your projects
            </Button>
          ) : (
            <Button variant="primary" icon="human" onClick={() => setUi({ signIn: true })}>
              Sign in
            </Button>
          )}
          <Button icon="arrow-right" onClick={() => navigate("/overview?project=demo")}>
            Try the sample
          </Button>
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

      <section className="home__sec" aria-labelledby="home-connect">
        <h2 className="home__h2" id="home-connect">
          Connect your agent
        </h2>
        <CodeBlock shell label="Terminal" code={command} />
        {signedIn ? (
          <p className="home__text">
            Create a personal API key on the <Link to="/connect">Connect page</Link>.
          </p>
        ) : (
          <p className="home__text">Sign in, then create a personal API key on the Connect page.</p>
        )}
      </section>

      <section className="home__sec" aria-labelledby="home-code">
        <h2 className="home__h2" id="home-code">
          Where your code goes
        </h2>
        <p className="home__text">
          Each project has a git repository in Cloudflare Artifacts. gitring can send merged code to GitHub as a pull request, or straight to main.
        </p>
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
