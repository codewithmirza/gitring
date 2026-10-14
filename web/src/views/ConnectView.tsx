/**
 * "/connect": add gitring to an agent as an MCP connector (no key to copy), or use an API key.
 *
 * Then git mode, the Claude Code hook, inputs from other apps and events out.
 * Requests: the connect info once for each project; the OAuth apps every 5 s only while this tab is visible
 * and no app is connected yet (agents that work on the project arrive over the live socket).
 * Read next: connect/ (the diagram, the connector section, the key section) and connect-text.ts (the words).
 */
import { useEffect, useState } from "react";
import { CodeBlock } from "../design/components";
import { Link } from "../app/router";
import { Icon } from "../design/icons";
import { harborOrNull, onHarbor, defaultConnectInfo, type ConnectInfo } from "../state/api";
import { useStore } from "../state/store";
import { APPROVAL_EVENT_HELP, WEBHOOK_EVENTS, lowerFirst } from "./approval-copy";
import { approvalExample, flowText, mcpEndpoints } from "./connect-text";
import { ConnectorSection } from "./connect/ConnectorSection";
import { FlowDiagram } from "./connect/FlowDiagram";
import { KeySection } from "./connect/KeySection";
import { Section, useNarrow } from "./connect/shared";
import "./connect.css";
import "./projects.css";

export function ConnectView() {
  const projectId = useStore((s) => s.projectId);
  const branch = useStore((s) => s.state?.project.repo.defaultBranch ?? "main");
  const githubOn = useStore((s) => (s.state?.project.settings.github?.mode ?? "off") !== "off");
  const [info, setInfo] = useState<ConnectInfo>(() => defaultConnectInfo(projectId));
  const narrow = useNarrow();

  useEffect(() => {
    setInfo(defaultConnectInfo(projectId));
    const load = () => {
      harborOrNull()
        ?.connect()
        // Fill fields that an older server does not send, so that the page never breaks on them.
        .then((i) => setInfo({ ...defaultConnectInfo(projectId), ...i, inputs: { ...defaultConnectInfo(projectId).inputs, ...(i?.inputs ?? {}) } }))
        .catch(() => undefined);
    };
    load();
    return onHarbor(load);
  }, [projectId]);

  const hook = JSON.stringify(
    {
      hooks: {
        PostToolUse: [
          {
            matcher: "Edit|MultiEdit|Write|Bash",
            hooks: [
              {
                type: "command",
                command: `curl -s -X POST '${info.hookUrl}' -H 'content-type: application/json' -H "authorization: Bearer $GITRING_KEY" --data-binary @-`,
              },
            ],
          },
        ],
      },
    },
    null,
    2,
  );
  const project = info.projectId || projectId;
  const endpoints = mcpEndpoints(info.mcpUrl);
  const payload = JSON.stringify(
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

  return (
    <div className="page connect">
      <p className="page__eyebrow">
        <Icon name="plug" size={14} /> Connect
      </p>
      <h1 className="page__title" tabIndex={-1}>
        Connect your agents
      </h1>
      <p className="page__lede">
        Agents work on this project through MCP or git. gitring checks each plan, sends change requests back to the agents, and merges the work into main when the
        tests pass. A person says yes first when the project asks.
      </p>

      <ConnectorSection mcpUrl={info.mcpUrl} />

      <KeySection info={info} />

      <section className="cx cx--wide" aria-labelledby="cx-flow">
        <div className="cx__text">
          <h2 className="page__h2" id="cx-flow">
            How work flows through gitring
          </h2>
        </div>
        <figure className="flowfig">
          <span className="vh" id="flow-title">
            How agents and apps connect to gitring
          </span>
          <span className="vh" id="flow-desc">
            {flowText(info, githubOn)}
          </span>
          <FlowDiagram vertical={narrow} info={info} githubOn={githubOn} />
        </figure>
      </section>

      <Section
        id="cx-modes"
        title="Two ways to work"
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
                Call <span className="code-inline">gitring_declare</span> with <span className="code-inline">mode</span> "git" and{" "}
                <span className="code-inline">workdir</span> set to your repository folder.
              </li>
              <li>Clone the work copy, or add it as a remote. Use the remote and the token from the answer. The token works for 6 hours.</li>
              <li>Commit, then push to that remote.</li>
              <li>
                Call <span className="code-inline">gitring_check</span>, then <span className="code-inline">gitring_submit</span>. gitring reads your latest push
                at check and at submit.
              </li>
              <li>
                Optional: call <span className="code-inline">gitring_log</span> with <span className="code-inline">headSha</span> after each push. You get a
                conflict check at once.
              </li>
            </ol>
          </>
        }
      >
        <CodeBlock
          shell
          label="Git mode, in your repository folder"
          code={`# 1. The answer of gitring_declare has a remote and a token.
export GITRING_REMOTE="<remote from the answer>"
export GITRING_TOKEN="<token from the answer>"
# 2. Add the work copy as a remote.
git remote add gitring "https://x:$GITRING_TOKEN@\${GITRING_REMOTE#https://}"
# 3. Commit, then push.
git push gitring HEAD:${branch}
# 4. Call gitring_check, then gitring_submit.`}
        />
      </Section>

      <Section
        id="cx-hook"
        title="Claude Code hook (optional)"
        aside={
          <>
            <p>Claude Code sends each edit to gitring. gitring answers with the change requests that wait for this agent. The hook uses an API key (GITRING_KEY).</p>
            <p>
              Give your repository folder as <span className="code-inline">workdir</span> when you call <span className="code-inline">gitring_declare</span>. The
              hook finds your work copy by that folder and adds waiting change requests to the agent's context.
            </p>
          </>
        }
      >
        <CodeBlock label=".claude/settings.json" code={hook} copyLabel="Copy hook" />
      </Section>

      <Section
        id="cx-in"
        title="Open tasks from other apps"
        aside={
          <>
            <p>Any app can open a task with one HTTP call and an API key of a project member.</p>
            {info.inputs.githubIssues && (
              <p>
                <strong>GitHub issues.</strong> Label an issue <span className="code-inline">gitring</span> in a GitHub repository that you imported into a project
                where you are a member. gitring opens a task.
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
                <strong>Slack.</strong> The command <span className="code-inline">/gitring Add a dark mode — Readers can switch to a dark theme.</span> opens a
                task. Set the command URL to <span className="code-inline">{info.slackUrl}</span>. The URL holds this project's key: do not share it.
              </p>
            )}
          </>
        }
      >
        <CodeBlock
          shell
          label="Terminal"
          code={`curl -X POST ${info.intentsUrl} \\
  -H 'content-type: application/json' \\
  -H "authorization: Bearer $GITRING_KEY" \\
  -d '{"project":"${project}","title":"Add a dark mode","goal":"Readers can switch to a dark theme."}'`}
        />
      </Section>

      <Section
        id="cx-out"
        title="Send events out"
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
        <CodeBlock label="POST to your webhook (JSON)" copyLabel="Copy example" code={payload} />
        <CodeBlock label="POST when a person must say yes (JSON)" copyLabel="Copy example" code={approvalExample(project, endpoints.origin)} />
      </Section>

      <Section
        id="cx-github"
        title="Send merged code to GitHub"
        aside={
          <p>
            Turn it on in <Link to="/settings?section=github">Settings → GitHub</Link>. gitring sends each merge to a pull request, or straight to main, and brings
            changes from GitHub in.
          </p>
        }
      >
        <div className="cx__links">
          <Link to="/settings?section=github" className="b-btn b-btn--secondary">
            <Icon name="fork" />
            Open the GitHub settings
          </Link>
        </div>
      </Section>
    </div>
  );
}
