/**
 * The first part of the connect page: "Which agent do you use?", then ONE command or ONE URL for that agent.
 * The agent choice stays in this browser. The other ways to connect are folded in MoreWays.tsx.
 */
import { useState, type ReactNode } from "react";
import { CodeBlock, Tabs, TabPanel } from "../../design/components";
import { Icon } from "../../design/icons";
import { TOOLS } from "../connect-text";
import { type Client, CLIENT_IDS, CLIENTS, cursorLink } from "./clients";
import { LiveStatus } from "./LiveStatus";
import { CopyField, jumpTo, useRemembered } from "./shared";

/* ───────────── small parts ───────────── */

/** The numbered steps of one agent. Step 1 holds the thing to copy, so that the person sees it first. */
function Steps({ children }: { children: ReactNode }) {
  return <ol className="cx-steps">{children}</ol>;
}

function Note({ children }: { children: ReactNode }) {
  return (
    <p className="cx__note">
      <Icon name="info" size={12} />
      <span>{children}</span>
    </p>
  );
}

/** The tools that an agent gets: one line each. For the person who writes a client by hand. */
function ToolList() {
  const [open, setOpen] = useState(false);
  return (
    <details className="cx-more" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>The tools that your agent gets</summary>
      {open && (
        <ul className="tools" aria-label="The gitring tools">
          {TOOLS.map(([t, d]) => (
            <li key={t}>
              <span className="voice-agent">{t}</span>
              <span>{d}</span>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

/* ───────────── the panel of each agent ───────────── */

function ClaudePanel({ mcpUrl }: { mcpUrl: string }) {
  return (
    <>
      <Steps>
        <li>
          Copy the URL.
          <CopyField value={mcpUrl} label="Connector URL" />
        </li>
        <li>
          In Claude, open <strong>Settings → Connectors</strong>, then click <strong>Add custom connector</strong>.{" "}
          <a href="https://claude.ai/settings/connectors" target="_blank" rel="noopener noreferrer">
            Open Claude settings <Icon name="external" size={12} className="cx-ext" />
          </a>
        </li>
        <li>
          Name it <span className="code-inline">gitring</span>, paste the URL and click <strong>Add</strong>. Then click <strong>Connect</strong>.
        </li>
        <li>
          gitring asks you to allow Claude. Click <strong>Allow</strong>. Claude can then read your projects, send plans and push work in any chat.
        </li>
      </Steps>
      <Note>On Team and Enterprise plans, an owner adds the connector in Organization settings → Connectors.</Note>
    </>
  );
}

function ClaudeCodePanel({ mcpUrl }: { mcpUrl: string }) {
  return (
    <>
      <Steps>
        <li>
          Run this command in your terminal.
          <CopyField command value={`claude mcp add --transport http --scope user gitring ${mcpUrl}`} label="Command for Claude Code" button="Copy command" />
        </li>
        <li>
          In Claude Code, type <span className="code-inline">/mcp</span>, choose <strong>gitring</strong>, then <strong>Authenticate</strong>.
        </li>
        <li>
          Your browser opens gitring. Click <strong>Allow</strong>.
        </li>
      </Steps>
      <Note>
        Optional: add the{" "}
        <a
          href="#cx-hook"
          onClick={(e) => {
            e.preventDefault();
            jumpTo("cx-hook");
          }}
        >
          Claude Code hook
        </a>
        . Then change requests also arrive in the middle of a task.
      </Note>
    </>
  );
}

function CursorPanel({ mcpUrl }: { mcpUrl: string }) {
  const json = JSON.stringify({ mcpServers: { gitring: { url: mcpUrl } } }, null, 2);
  return (
    <>
      <Steps>
        <li>
          Click the button. Cursor opens and asks to install gitring.
          <span className="cx-row">
            <a className="b-btn b-btn--primary cx-cursor" href={cursorLink(mcpUrl)}>
              <Icon name="plus" />
              Add to Cursor
            </a>
          </span>
        </li>
        <li>
          In Cursor, open <strong>Settings → MCP</strong> and click <strong>Login</strong> next to gitring.
        </li>
        <li>
          Your browser opens gitring. Click <strong>Allow</strong>.
        </li>
      </Steps>
      <details className="cx-more">
        <summary>Add it by hand</summary>
        <CodeBlock label="~/.cursor/mcp.json" code={json} copyLabel="Copy config" />
      </details>
    </>
  );
}

function CodexPanel({ mcpUrl }: { mcpUrl: string }) {
  return (
    <>
      <Steps>
        <li>
          Run these two commands in your terminal.
          <CopyField command value={`codex mcp add gitring --url ${mcpUrl}\ncodex mcp login gitring`} label="Commands for Codex" button="Copy commands" />
        </li>
        <li>
          The second command opens your browser. Click <strong>Allow</strong>.
        </li>
      </Steps>
      <Note>In the Codex app: Settings → MCP servers → Add server, then paste the URL.</Note>
    </>
  );
}

function OtherPanel({ mcpUrl }: { mcpUrl: string }) {
  return (
    <>
      <CopyField value={mcpUrl} label="Connector URL" />
      <p className="cx__step">Any agent app that speaks MCP can use this URL. The app signs in with your gitring account.</p>
      <details className="cx-more">
        <summary>How the sign-in works</summary>
        <p className="cx__step">
          The app signs in with OAuth 2.1, with dynamic client registration and PKCE. It finds the sign-in by itself in the metadata at{" "}
          <span className="code-inline">/.well-known/oauth-protected-resource</span>.
        </p>
      </details>
      <p className="cx__step">
        An app that cannot sign in sends a personal API key in the header <span className="code-inline">Authorization: Bearer gk_…</span>. Read{" "}
        <a
          href="#cx-keys"
          onClick={(e) => {
            e.preventDefault();
            jumpTo("cx-keys");
          }}
        >
          Use an API key
        </a>
        .
      </p>
      <ToolList />
    </>
  );
}

/* ───────────── the section ───────────── */

export function ConnectorSection({ mcpUrl }: { mcpUrl: string }) {
  const [client, setClient] = useRemembered<Client>("gitring.connect.client", "claude-code", CLIENT_IDS);
  return (
    <section className="cx-hero" aria-labelledby="cx-connector">
      <div className="cx-hero__text">
        <h2 className="page__h2" id="cx-connector">
          Which agent do you use?
        </h2>
        <p>Your agent signs in with your gitring account. You do not copy a key.</p>
      </div>
      <Tabs<Client> label="Your agent" idPrefix="cxc" value={client} onChange={setClient} tabs={CLIENTS} />
      <TabPanel idPrefix="cxc" id="claude" active={client === "claude"} className="cx__panel">
        <ClaudePanel mcpUrl={mcpUrl} />
      </TabPanel>
      <TabPanel idPrefix="cxc" id="claude-code" active={client === "claude-code"} className="cx__panel">
        <ClaudeCodePanel mcpUrl={mcpUrl} />
      </TabPanel>
      <TabPanel idPrefix="cxc" id="cursor" active={client === "cursor"} className="cx__panel">
        <CursorPanel mcpUrl={mcpUrl} />
      </TabPanel>
      <TabPanel idPrefix="cxc" id="codex" active={client === "codex"} className="cx__panel">
        <CodexPanel mcpUrl={mcpUrl} />
      </TabPanel>
      <TabPanel idPrefix="cxc" id="other" active={client === "other"} className="cx__panel">
        <OtherPanel mcpUrl={mcpUrl} />
      </TabPanel>
      <LiveStatus client={client} />
    </section>
  );
}
