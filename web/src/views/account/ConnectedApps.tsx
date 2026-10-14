/**
 * The apps that the person allowed through OAuth (MCP clients such as Claude and Cursor), each with a revoke button.
 */
import type { OAuthGrantInfo } from "../../../../src/core/accounts";
import { InlineConfirm, SkeletonRows } from "../../design/components";
import { Icon } from "../../design/icons";
import { useMe } from "../../state/account";
import { listGrants, revokeGrant, useResource } from "../../state/connections";
import { ago } from "../../state/format";
import { Link } from "../../app/router";
import { dateText, host } from "./format";

function AppRow({ g, now, onGone }: { g: OAuthGrantInfo; now: number; onGone: (id: string) => void }) {
  const h = host(g.clientUri);
  return (
    <li className="acct-row">
      <span className="acct-row__mark">
        <Icon name="apps" />
      </span>
      <div className="acct-row__text">
        <span className="acct-row__name">
          {g.clientName}
          {h && <span className="acct-row__host"> · {h}</span>}
        </span>
        <span className="acct-row__meta">
          Allowed {dateText(g.createdAt)} · {g.lastUsedAt ? `last used ${ago(g.lastUsedAt, now)}` : "not used yet"}
          {g.scope ? ` · ${g.scope}` : ""}
        </span>
      </div>
      <div className="acct-row__acts">
        <InlineConfirm
          label="Revoke"
          ariaLabel={`Revoke ${g.clientName}`}
          consequence="The app stops at once. Its work copies stay."
          confirmLabel="Revoke"
          onConfirm={async () => {
            await revokeGrant(g.id);
            onGone(g.id);
          }}
        />
      </div>
    </li>
  );
}

export function ConnectedApps({ now }: { now: number }) {
  const signedIn = Boolean(useMe()?.user);
  const apps = useResource<OAuthGrantInfo[]>("grants", (o) => listGrants(o), signedIn);
  return (
    <section className="acct-sec" aria-labelledby="acct-apps" id="apps">
      <div className="acct-sec__head">
        <h2 className="page__h2" id="acct-apps">
          Connected apps
        </h2>
        <p className="acct-sec__lede">Agents and apps that you allowed to use gitring as you, through MCP and OAuth. Revoke one, and it must ask you again.</p>
      </div>
      {apps.loading && !apps.data ? (
        <SkeletonRows rows={2} label="Please wait for the connected apps" />
      ) : apps.error ? (
        <p className="acct-error" role="alert">
          <Icon name="cross" size={14} /> gitring could not load the apps. {apps.error.message}{" "}
          <button type="button" className="acct-link" onClick={apps.reload}>
            Try again
          </button>
        </p>
      ) : apps.data && apps.data.length ? (
        <ul className="acct-rows" role="list">
          {apps.data.map((g) => (
            <AppRow key={g.id} g={g} now={now} onGone={(id) => apps.set((l) => (l ?? []).filter((x) => x.id !== id))} />
          ))}
        </ul>
      ) : (
        <div className="acct-empty">
          <p>No connected apps. Add gitring to Claude, Claude Code, Cursor or Codex with one URL.</p>
          <Link to="/connect" className="b-btn b-btn--secondary b-btn--sm">
            <Icon name="plug" />
            Connect an agent
          </Link>
        </div>
      )}
    </section>
  );
}
