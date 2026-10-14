/**
 * The API key section: a personal key for scripts, hooks and clients without OAuth, with setup text.
 * The key shows one time only. The text of each tab comes from ../connect-text.ts.
 */
import { useState, type FormEvent } from "react";
import { Button, CodeBlock, Field, Input, Tabs, TabPanel } from "../../design/components";
import { createKey, useMe } from "../../state/account";
import { openSignIn } from "../../app/ui";
import { Link } from "../../app/router";
import { Icon } from "../../design/icons";
import { type ConnectInfo } from "../../state/api";
import { Way, useRemembered } from "./shared";

type KeyClient = "claude-code" | "codex" | "cursor" | "other";
const KEY_TABS: { id: KeyClient; label: string }[] = [
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "cursor", label: "Cursor" },
  { id: "other", label: "Other" },
];

/** A personal API key: for scripts, hooks and clients without OAuth. The key shows one time only. */
export function KeySection({ info }: { info: ConnectInfo }) {
  const me = useMe();
  const signedIn = Boolean(me?.user);
  const [tab, setTab] = useRemembered<KeyClient>("gitring.connect.keytab", "claude-code", KEY_TABS.map((t) => t.id));
  const [name, setName] = useState("my laptop");
  const [fresh, setFresh] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await createKey(name.trim() || "key");
      setFresh(res.key);
    } catch (err) {
      setError(`The key was not created. ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const cursor = JSON.stringify({ mcpServers: { gitring: { url: info.mcpUrl, headers: { Authorization: "Bearer ${env:GITRING_KEY}" } } } }, null, 2);
  return (
    <Way
      id="cx-keys"
      title="Use an API key"
      note="For scripts, and for agent apps that cannot sign in."
      aside={
        <>
          <p>For scripts, hooks and MCP clients without OAuth. A key acts as you: it can do what your roles allow on each project. Keep it in an environment variable.</p>
          <p className="cx__note">
            <Icon name="info" size={12} />
            <span>
              See and revoke your keys on your <Link to="/account">account page</Link>. If a key leaks, revoke it at once.
            </span>
          </p>
        </>
      }
    >
      {signedIn ? (
        <form className="keys__new" onSubmit={create}>
          <Field label="Key name" help="Where you use the key, for example “my laptop” or “CI”.">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
          </Field>
          <Button type="submit" icon="plus" busy={busy}>
            Create key
          </Button>
        </form>
      ) : (
        <div className="cx-row">
          <span className="cx__step">Sign in to create a key.</span>
          <Button size="sm" variant="primary" onClick={openSignIn}>
            Sign in
          </Button>
        </div>
      )}
      {error && (
        <p className="st-error" role="alert">
          <Icon name="cross" size={12} /> {error}
        </p>
      )}
      {fresh && (
        <div className="keys__fresh" role="status">
          <p>Copy the key now. gitring shows it only once.</p>
          <CodeBlock shell label="Terminal" code={`export GITRING_KEY=${fresh}`} copyLabel="Copy key" />
        </div>
      )}
      <Tabs<KeyClient> label="Agent client with an API key" idPrefix="cxk" value={tab} onChange={setTab} tabs={KEY_TABS} />
      <TabPanel idPrefix="cxk" id="claude-code" active={tab === "claude-code"} className="cx__panel">
        <CodeBlock shell label="Terminal" code={`claude mcp add --transport http gitring ${info.mcpUrl} --header "Authorization: Bearer $GITRING_KEY"`} />
      </TabPanel>
      <TabPanel idPrefix="cxk" id="codex" active={tab === "codex"} className="cx__panel">
        <CodeBlock label="~/.codex/config.toml" code={`[mcp_servers.gitring]\nurl = "${info.mcpUrl}"\nbearer_token_env_var = "GITRING_KEY"`} copyLabel="Copy config" />
      </TabPanel>
      <TabPanel idPrefix="cxk" id="cursor" active={tab === "cursor"} className="cx__panel">
        <CodeBlock label=".cursor/mcp.json" code={cursor} copyLabel="Copy config" />
        <p className="cx__step">Restart Cursor. The gitring tools show in the MCP list.</p>
      </TabPanel>
      <TabPanel idPrefix="cxk" id="other" active={tab === "other"} className="cx__panel">
        <CodeBlock label="MCP endpoint (streamable HTTP, header Authorization: Bearer <key>)" code={info.mcpUrl} copyLabel="Copy URL" />
      </TabPanel>
    </Way>
  );
}
