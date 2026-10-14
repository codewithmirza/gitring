/**
 * "More ways" on the connect page: every other way to connect or to use gitring, each folded and closed at first.
 * A link to "#cx-…" opens the way and scrolls to it. The main path (one agent, one command) is in ConnectorSection.tsx.
 */
import { useEffect } from "react";
import { CodeBlock } from "../../design/components";
import { Icon } from "../../design/icons";
import { Link } from "../../app/router";
import { type ConnectInfo } from "../../state/api";
import { APPROVAL_EVENT_HELP, WEBHOOK_EVENTS, lowerFirst } from "../approval-copy";
import { GITHUB_SWAP, MERGE_QUESTION, READ_ONLY, approvalExample, flowText, mcpEndpoints } from "../connect-text";
import { FlowDiagram } from "./FlowDiagram";
import { KeySection } from "./KeySection";
import { CopyField, Inline, Way, jumpTo, useNarrow } from "./shared";

/* ───────────── examples ───────────── */

/** The settings of Claude Code that send each edit to gitring. */
function hookJson(hookUrl: string): string {
  return JSON.stringify(
    {
      hooks: {
        PostToolUse: [
          {
            matcher: "Edit|MultiEdit|Write|Bash",
            hooks: [
              {
                type: "command",
                command: `curl -s -X POST '${hookUrl}' -H 'content-type: application/json' -H "authorization: Bearer $GITRING_KEY" --data-binary @-`,
              },
            ],
          },
        ],
      },
    },
    null,
    2,
  );
}

/** The JSON that a webhook gets when a merge happens (an example). */
function mergeEventJson(project: string): string {
  return JSON.stringify(
    {
      event: "landing",
      project,
      at: "2026-10-10T12:00:00.000Z",
      landing: { id: "…", intentId: "…", attemptId: "…", method: "merge", mainBefore: "…", mainAfter: "…", correctionsApplied: 1 },
      intent: { id: "…", title: "…" },
      callsign: "…",
      mainSha: "…",
    },
    null,
    2,
  );
}

function gitModeCommands(branch: string): string {
  return `# 1. The answer of gitring_declare has a remote and a token.
export GITRING_REMOTE="<remote from the answer>"
export GITRING_TOKEN="<token from the answer>"
# 2. Add the work copy as a remote.
git remote add gitring "https://x:$GITRING_TOKEN@\${GITRING_REMOTE#https://}"
# 3. Commit, then push.
git push gitring HEAD:${branch}
# 4. Call gitring_check, then gitring_submit.`;
}

function taskCommand(info: ConnectInfo, project: string): string {
  return `curl -X POST ${info.intentsUrl} \\
  -H 'content-type: application/json' \\
  -H "authorization: Bearer $GITRING_KEY" \\
  -d '{"project":"${project}","title":"Add a dark mode","goal":"Readers can switch to a dark theme."}'`;
}

/* ───────────── ways ───────────── */

function GitMode({ branch }: { branch: string }) {
  return (
    <Way
      id="cx-modes"
      title="Work in git mode"
      note="The agent works in your repository folder and pushes with git."
      aside={
        <>
          <p>
            <strong>Edit through gitring.</strong> The agent reads and writes files with <span className="code-inline">gitring_read</span> and{" "}
            <span className="code-inline">gitring_write</span>. gitring keeps the work copy. This is good for small changes.
          </p>
          <p>
            <strong>Git mode.</strong> We recommend it for agents on your computer. The agent works in your repository folder and pushes with git.
          </p>
          <ol className="cx__steps">
            <li>
              Call <span className="code-inline">gitring_declare</span> with <span className="code-inline">mode</span> "git" and <span className="code-inline">workdir</span>{" "}
              set to your repository folder.
            </li>
            <li>Clone the work copy, or add it as a remote. Use the remote and the token from the answer. The token works for 6 hours.</li>
            <li>Commit, then push to that remote.</li>
            <li>
              Call <span className="code-inline">gitring_check</span>, then <span className="code-inline">gitring_submit</span>. gitring reads your latest push at check
              and at submit.
            </li>
            <li>
              Optional: call <span className="code-inline">gitring_log</span> with <span className="code-inline">headSha</span> after each push. You get a conflict check
              at once.
            </li>
          </ol>
        </>
      }
    >
      <CodeBlock shell label="Git mode, in your repository folder" code={gitModeCommands(branch)} />
    </Way>
  );
}

function ClaudeCodeHook({ hookUrl }: { hookUrl: string }) {
  return (
    <Way
      id="cx-hook"
      title="Add the Claude Code hook"
      note="Change requests arrive in the middle of a task. Optional."
      aside={
        <>
          <p>Claude Code sends each edit to gitring. gitring answers with the change requests that wait for this agent. The hook uses an API key (GITRING_KEY).</p>
          <p>
            Give your repository folder as <span className="code-inline">workdir</span> when you call <span className="code-inline">gitring_declare</span>. The hook finds
            your work copy by that folder and adds waiting change requests to the agent's context.
          </p>
        </>
      }
    >
      <CodeBlock label=".claude/settings.json" code={hookJson(hookUrl)} copyLabel="Copy hook" />
    </Way>
  );
}

/** What gitring does when an agent asks for a merge: three short lines, with two links. */
function MergeQuestion() {
  return (
    <Way id="cx-ask" title={MERGE_QUESTION.title} note="gitring may ask you to say yes first.">
      <ul className="cx-lines">
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
    </Way>
  );
}

function TasksFromApps({ info, project }: { info: ConnectInfo; project: string }) {
  return (
    <Way
      id="cx-in"
      title="Open tasks from other apps"
      note="One HTTP call, a GitHub issue or a Slack command."
      aside={
        <>
          <p>Any app can open a task with one HTTP call and an API key of a project member.</p>
          {info.inputs.githubIssues && (
            <p>
              <strong>GitHub issues.</strong> Label an issue <span className="code-inline">gitring</span> in a GitHub repository that you imported into a project where you
              are a member. gitring opens a task.
            </p>
          )}
          {info.githubHookUrl && (
            <p>
              <strong>A repository webhook</strong> (without the GitHub App): add a webhook for issues to the project's own repository, with the payload URL{" "}
              <span className="code-inline">{info.githubHookUrl}</span> and the deployment's webhook secret. The URL holds this project's key: do not share it.
            </p>
          )}
          {info.inputs.slack && info.slackUrl && (
            <p>
              <strong>Slack.</strong> The command <span className="code-inline">/gitring Add a dark mode — Readers can switch to a dark theme.</span> opens a task. Set the
              command URL to <span className="code-inline">{info.slackUrl}</span>. The URL holds this project's key: do not share it.
            </p>
          )}
        </>
      }
    >
      <CodeBlock shell label="Terminal" code={taskCommand(info, project)} />
    </Way>
  );
}

function EventsOut({ project, origin }: { project: string; origin: string }) {
  return (
    <Way
      id="cx-out"
      title="Send events out"
      note="A webhook tells another tool about a merge or a question."
      aside={
        <>
          <p>
            Add a webhook in <Link to="/settings?section=webhooks">Settings → Webhooks</Link>. gitring sends these events as JSON, or as Slack messages:
          </p>
          <ul className="cx__events">
            {WEBHOOK_EVENTS.map((ev) => (
              <li key={ev.value}>
                <span className="code-inline">{ev.value}</span> {lowerFirst(ev.label)}
              </li>
            ))}
          </ul>
          <p>
            For <span className="code-inline">approval</span>, {lowerFirst(APPROVAL_EVENT_HELP)}
          </p>
        </>
      }
    >
      <CodeBlock label="POST to your webhook (JSON)" copyLabel="Copy example" code={mergeEventJson(project)} />
      <CodeBlock label="POST when a person must say yes (JSON)" copyLabel="Copy example" code={approvalExample(project, origin)} />
    </Way>
  );
}

function GithubWay() {
  return (
    <Way
      id="cx-github"
      title="Send merged code to GitHub"
      note="Optional. Turn it on in Settings."
      aside={
        <p>
          Turn it on in <Link to="/settings?section=github">Settings → GitHub</Link>. gitring sends each merge to a pull request, or straight to main, and brings changes
          from GitHub in.
        </p>
      }
    >
      <div className="cx__links">
        <Link to="/settings?section=github" className="b-btn b-btn--secondary">
          <Icon name="fork" />
          Open the GitHub settings
        </Link>
      </div>
    </Way>
  );
}

/** The two other MCP addresses of this gitring. Each has its own copy button. */
function OtherAddresses({ mcpUrl }: { mcpUrl: string }) {
  const endpoints = mcpEndpoints(mcpUrl);
  return (
    <>
      <Way id="cx-github-swap" title={GITHUB_SWAP.summary} note="Use another URL. The tools keep the GitHub names.">
        <CopyField value={endpoints.github} label={GITHUB_SWAP.label} variant="secondary" />
        <ul className="cx-lines">
          {GITHUB_SWAP.lines.map((line) => (
            <li key={line}>
              <Inline text={line} />
            </li>
          ))}
        </ul>
      </Way>
      <Way id="cx-readonly" title={READ_ONLY.summary} note="A URL for agents that only look.">
        <CopyField value={endpoints.readonly} label={READ_ONLY.label} variant="secondary" />
        <p className="cx__step">
          <Inline text={READ_ONLY.text} />
        </p>
      </Way>
    </>
  );
}

function Flow({ info, githubOn }: { info: ConnectInfo; githubOn: boolean }) {
  const narrow = useNarrow();
  return (
    <Way id="cx-flow" title="How work flows through gitring" note="What goes in, what gitring does, and what goes out.">
      <figure className="flowfig">
        <span className="vh" id="flow-title">
          How agents and apps connect to gitring
        </span>
        <span className="vh" id="flow-desc">
          {flowText(info, githubOn)}
        </span>
        <FlowDiagram vertical={narrow} info={info} githubOn={githubOn} />
      </figure>
    </Way>
  );
}

/* ───────────── the part ───────────── */

export function MoreWays({ info, project, branch, githubOn }: { info: ConnectInfo; project: string; branch: string; githubOn: boolean }) {
  const origin = mcpEndpoints(info.mcpUrl).origin;
  // A link such as /connect#cx-out opens the way that it names.
  useEffect(() => {
    const open = () => {
      const id = location.hash.slice(1);
      if (id.startsWith("cx-")) requestAnimationFrame(() => jumpTo(id));
    };
    open();
    window.addEventListener("hashchange", open);
    return () => window.removeEventListener("hashchange", open);
  }, []);
  return (
    <section className="cx-more-ways" aria-labelledby="cx-more-ways">
      <h2 className="page__h2" id="cx-more-ways">
        More ways
      </h2>
      <div className="cx-ways">
        <KeySection info={info} />
        <GitMode branch={branch} />
        <ClaudeCodeHook hookUrl={info.hookUrl} />
        <MergeQuestion />
        <TasksFromApps info={info} project={project} />
        <EventsOut project={project} origin={origin} />
        <GithubWay />
        <OtherAddresses mcpUrl={info.mcpUrl} />
        <Flow info={info} githubOn={githubOn} />
      </div>
    </section>
  );
}
