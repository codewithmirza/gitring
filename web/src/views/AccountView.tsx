/**
 * /account — the person: profile and account id, passkeys, the other sign-ins (Google, GitHub and the
 * GitHub connection), the apps they allowed through OAuth (MCP clients such as Claude, Claude Code,
 * Cursor and Codex), personal API keys, and sign out.
 * Destructive actions confirm in place; nothing opens a modal.
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ApiKeyInfo, OAuthGrantInfo, PasskeyInfo } from "../../../src/core/accounts";
import { Button, CodeBlock, InlineConfirm, Input, SkeletonRows } from "../design/components";
import { Icon } from "../design/icons";
import { GitHubMark, GoogleG } from "../design/brand/marks";
import { loadMe, useMe, signOut, signOutEverywhere } from "../state/account";
import { connectGithub, createKey, disconnectGithub, listGrants, listKeys, revokeGrant, revokeKey, useResource } from "../state/connections";
import { addPasskey, listPasskeys, passkeyErrorText, passkeysWork, PasskeyStopped, removePasskey, renamePasskey } from "../state/passkey";
import { ago } from "../state/format";
import { useNow } from "../app/useNow";
import { Link } from "../app/router";
import { lastProvider, SignInChoices } from "../app/Account";
import { orderedProviders } from "../state/signin";
import "./account.css";

function host(uri?: string): string | null {
  if (!uri) return null;
  try {
    return new URL(uri).host;
  } catch {
    return null;
  }
}

function dateText(ms: number): string {
  return new Date(ms).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

/* ───────────── passkeys ───────────── */

function PasskeyRow({ pk, now, last, onGone, onRenamed }: { pk: PasskeyInfo; now: number; last: boolean; onGone: (id: string) => void; onRenamed: (pk: PasskeyInfo) => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(pk.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const renameRef = useRef<HTMLButtonElement | null>(null);
  const close = (next = pk.name) => {
    setEditing(false);
    setError(null);
    setName(next);
    requestAnimationFrame(() => renameRef.current?.focus());
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const renamed = await renamePasskey(pk.id, name);
      onRenamed(renamed);
      close(renamed.name);
    } catch (err) {
      setError(passkeyErrorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="acct-row">
      <span className="acct-row__mark">
        <Icon name="key" />
      </span>
      <div className="acct-row__text">
        {editing ? (
          <form
            className="acct-rename"
            onSubmit={save}
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              e.preventDefault();
              close();
            }}
          >
            <Input aria-label="Passkey name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="off" autoFocus />
            <Button type="submit" size="sm" variant="primary" busy={busy}>
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => close()}>
              Cancel
            </Button>
            {error && (
              <p className="acct-error" role="alert">
                <Icon name="cross" size={14} /> {error}
              </p>
            )}
          </form>
        ) : (
          <span className="acct-row__name">{pk.name}</span>
        )}
        <span className="acct-row__meta">
          Added {dateText(pk.createdAt)} · {pk.lastUsed ? `last used ${ago(pk.lastUsed, now)}` : "not used yet"}
          {last ? " · your only way to sign in" : ""}
        </span>
      </div>
      <div className="acct-row__acts">
        {!editing && (
          <Button ref={renameRef} size="sm" variant="ghost" aria-label={`Rename the passkey ${pk.name}`} onClick={() => setEditing(true)}>
            Rename
          </Button>
        )}
        {!last && (
          <InlineConfirm
            label="Remove"
            ariaLabel={`Remove the passkey ${pk.name}`}
            consequence="This passkey no longer signs in to gitring. Your device keeps it until you delete it there."
            confirmLabel="Remove"
            onConfirm={async () => {
              await removePasskey(pk.id);
              onGone(pk.id);
            }}
          />
        )}
      </div>
    </li>
  );
}

function Passkeys({ now }: { now: number }) {
  const me = useMe();
  const signedIn = Boolean(me?.user);
  const keys = useResource<PasskeyInfo[]>("passkeys", (o) => listPasskeys(o), signedIn);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canPasskey = passkeysWork();
  const list = keys.data ?? [];
  // A person without Google or GitHub keeps one passkey: the Worker refuses to remove the last one.
  const onlyWay = (me?.user?.identities.length ?? 0) === 0 && list.length === 1;
  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const pk = await addPasskey();
      keys.set((l) => [...(l ?? []).filter((x) => x.id !== pk.id), pk]);
      void loadMe().catch(() => undefined);
    } catch (e) {
      if (!(e instanceof PasskeyStopped)) setError(passkeyErrorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="acct-sec" aria-labelledby="acct-passkeys" id="passkeys">
      <div className="acct-sec__head">
        <h2 className="page__h2" id="acct-passkeys">
          Passkeys
        </h2>
        <p className="acct-sec__lede">
          Sign in with a fingerprint, a face, a PIN or a security key. Your device keeps the passkey. gitring keeps only its public key.
        </p>
      </div>
      {keys.loading && !keys.data ? (
        <SkeletonRows rows={1} label="Loading your passkeys" />
      ) : keys.error ? (
        <p className="acct-error" role="alert">
          <Icon name="cross" size={14} /> gitring could not load the passkeys. {keys.error.message}{" "}
          <button type="button" className="acct-link" onClick={keys.reload}>
            Try again
          </button>
        </p>
      ) : list.length ? (
        <ul className="acct-rows" role="list" aria-label="Your passkeys">
          {list.map((pk) => (
            <PasskeyRow
              key={pk.id}
              pk={pk}
              now={now}
              last={onlyWay}
              onGone={(id) => {
                keys.set((l) => (l ?? []).filter((x) => x.id !== id));
                void loadMe().catch(() => undefined);
              }}
              onRenamed={(next) => keys.set((l) => (l ?? []).map((x) => (x.id === next.id ? next : x)))}
            />
          ))}
        </ul>
      ) : (
        <p className="acct-empty">No passkeys yet. Add one, and sign in without another account.</p>
      )}
      <div className="acct-actions">
        <Button size="sm" icon="plus" onClick={() => void add()} busy={busy} disabled={!canPasskey}>
          Add a passkey
        </Button>
        {!canPasskey && <span className="b-field__help">This browser cannot make passkeys. Use another browser.</span>}
        {error && (
          <p className="acct-error" role="alert">
            <Icon name="cross" size={14} /> {error}
          </p>
        )}
      </div>
    </section>
  );
}

/* ───────────── other sign-ins (Google, GitHub) ───────────── */

/** The outside sign-ins: only the providers that this gitring has, or that the person used before. */
function SignInMethods() {
  const me = useMe();
  if (!me?.user) return null;
  const u = me.user;
  const gh = u.identities.find((i) => i.provider === "github");
  const gg = u.identities.find((i) => i.provider === "google");
  const conn = me.github;
  const install = me.githubInstallUrl;
  const here = `${location.pathname}${location.search}`;
  const shown = orderedProviders({ github: Boolean(gh) || me.providers.github, google: Boolean(gg) || me.providers.google }, lastProvider());
  if (!shown.length) return null;
  const rows = {
    github: (
      <li className="acct-row" key="github">
        <span className="acct-row__mark acct-row__mark--github">
          <GitHubMark size={20} />
        </span>
        <div className="acct-row__text">
          <span className="acct-row__name">GitHub</span>
          <span className="acct-row__meta">
            {gh ? `Signed in as @${gh.login}.` : "Not used for sign-in."}{" "}
            {conn?.connected
              ? `gitring can list your repositories${conn.login ? ` as @${conn.login}` : ""} and send merged code back.`
              : conn?.reason
                ? conn.reason
                : gh
                  ? "Connect GitHub to import repositories and send merged code back."
                  : ""}
          </span>
        </div>
        <div className="acct-row__acts">
          {conn?.connected ? (
            <>
              {install && (
                <a className="b-btn b-btn--ghost b-btn--sm" href={install} target="_blank" rel="noopener noreferrer">
                  <Icon name="external" />
                  Add repositories on GitHub
                </a>
              )}
              <InlineConfirm
                label="Disconnect"
                ariaLabel="Disconnect GitHub"
                consequence="gitring forgets the GitHub token. Sign-in with GitHub still works."
                confirmLabel="Disconnect"
                onConfirm={() => disconnectGithub()}
              />
            </>
          ) : (
            me.providers.github && (
              <Button size="sm" variant={gh ? "primary" : "secondary"} onClick={() => connectGithub(here)}>
                {gh ? "Connect GitHub" : "Add GitHub"}
              </Button>
            )
          )}
        </div>
      </li>
    ),
    google: (
      <li className="acct-row" key="google">
        <span className="acct-row__mark">
          <GoogleG size={20} />
        </span>
        <div className="acct-row__text">
          <span className="acct-row__name">Google</span>
          <span className="acct-row__meta">
            {gg ? `Signed in as ${gg.email}.` : me.providers.google ? "Add a Google sign-in to this account." : "Not set up on this server."}
          </span>
        </div>
        <div className="acct-row__acts">
          {!gg && me.providers.google && (
            <Button size="sm" onClick={() => (location.href = `/auth/google/start?link=1&return=${encodeURIComponent(here)}`)}>
              Add Google
            </Button>
          )}
        </div>
      </li>
    ),
  };
  return (
    <section className="acct-sec" aria-labelledby="acct-signin">
      <div className="acct-sec__head">
        <h2 className="page__h2" id="acct-signin">
          Other sign-in methods
        </h2>
        <p className="acct-sec__lede">You can also sign in to gitring with these accounts. gitring keeps the name, email and avatar that they send.</p>
      </div>
      <ul className="acct-rows" role="list">
        {shown.map((p) => rows[p])}
      </ul>
    </section>
  );
}

/* ───────────── connected apps ───────────── */

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

function ConnectedApps({ now }: { now: number }) {
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
        <SkeletonRows rows={2} label="Loading the connected apps" />
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

/* ───────────── API keys ───────────── */

function KeyRow({ k, now, onGone }: { k: ApiKeyInfo; now: number; onGone: (id: string) => void }) {
  return (
    <li className="acct-row">
      <span className="acct-row__mark">
        <Icon name="key" />
      </span>
      <div className="acct-row__text">
        <span className="acct-row__name">
          {k.name} <span className="voice-agent acct-row__prefix">{k.prefix}…</span>
        </span>
        <span className="acct-row__meta">
          Created {dateText(k.createdAt)} · {k.lastUsed ? `last used ${ago(k.lastUsed, now)}` : "not used yet"}
        </span>
      </div>
      <div className="acct-row__acts">
        <InlineConfirm
          label="Revoke"
          ariaLabel={`Revoke the key ${k.name}`}
          consequence="Scripts and agents with this key stop at once."
          confirmLabel="Revoke"
          onConfirm={async () => {
            await revokeKey(k.id);
            onGone(k.id);
          }}
        />
      </div>
    </li>
  );
}

function ApiKeys({ now }: { now: number }) {
  const signedIn = Boolean(useMe()?.user);
  const keys = useResource<ApiKeyInfo[]>("keys", (o) => listKeys(o), signedIn);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("my laptop");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<{ key: string; name: string } | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const addRef = useRef<HTMLButtonElement | null>(null);

  // "/account#keys" (from the palette or the Connect page) opens the name field.
  useEffect(() => {
    if (location.hash !== "#keys") return;
    document.getElementById("keys")?.scrollIntoView({ block: "start" });
    setAdding(true);
  }, []);
  useEffect(() => {
    if (adding) requestAnimationFrame(() => nameRef.current?.select());
  }, [adding]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await createKey(name.trim() || "key");
      setFresh({ key: res.key, name: res.info.name });
      keys.set((l) => [...(l ?? []).filter((k) => k.id !== res.info.id), res.info]);
      setAdding(false);
    } catch (err) {
      setError(`The key was not created: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="acct-sec" aria-labelledby="acct-keys" id="keys">
      <div className="acct-sec__head">
        <h2 className="page__h2" id="acct-keys">
          API keys
        </h2>
        <p className="acct-sec__lede">
          For scripts, hooks and agents without OAuth: they send <span className="code-inline">Authorization: Bearer gk_…</span>. A key acts as you. Agents that sign
          in with OAuth do not need a key.
        </p>
      </div>
      {fresh && (
        <div className="acct-fresh" role="status">
          <p>
            Copy the key “{fresh.name}” now. gitring shows it only once.
          </p>
          <CodeBlock shell label="Terminal" code={`export GITRING_KEY=${fresh.key}`} copyLabel="Copy key" />
          <Button size="sm" variant="ghost" onClick={() => setFresh(null)}>
            I copied it
          </Button>
        </div>
      )}
      {adding ? (
        <form
          className="acct-newkey"
          onSubmit={create}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.preventDefault();
            setAdding(false);
            requestAnimationFrame(() => addRef.current?.focus());
          }}
        >
          <label className="b-field__label" htmlFor="acct-keyname">
            Key name
          </label>
          <Input id="acct-keyname" ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoComplete="off" aria-describedby="acct-keyhelp" />
          <Button type="submit" size="sm" variant="primary" busy={busy}>
            Create key
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
            Cancel
          </Button>
          <span className="b-field__help" id="acct-keyhelp">
            Where you use the key, for example “my laptop” or “CI”.
          </span>
          {error && (
            <p className="acct-error" role="alert">
              <Icon name="cross" size={14} /> {error}
            </p>
          )}
        </form>
      ) : (
        <div>
          <Button ref={addRef} size="sm" icon="plus" onClick={() => setAdding(true)}>
            Create key
          </Button>
        </div>
      )}
      {keys.loading && !keys.data ? (
        <SkeletonRows rows={2} label="Loading the API keys" />
      ) : keys.error ? (
        <p className="acct-error" role="alert">
          <Icon name="cross" size={14} /> gitring could not load the keys. {keys.error.message}{" "}
          <button type="button" className="acct-link" onClick={keys.reload}>
            Try again
          </button>
        </p>
      ) : keys.data && keys.data.length ? (
        <ul className="acct-rows" role="list" aria-label="Your API keys">
          {keys.data.map((k) => (
            <KeyRow key={k.id} k={k} now={now} onGone={(id) => keys.set((l) => (l ?? []).filter((x) => x.id !== id))} />
          ))}
        </ul>
      ) : (
        <p className="acct-empty">No API keys.</p>
      )}
    </section>
  );
}

/* ───────────── page ───────────── */

export function AccountView() {
  const me = useMe();
  const now = useNow(30_000);
  if (!me) {
    return (
      <div className="page acct">
        <h1 className="page__title" tabIndex={-1}>
          Account
        </h1>
        <SkeletonRows rows={4} label="Loading your account" />
      </div>
    );
  }
  if (!me.user) {
    return (
      <div className="page acct">
        <h1 className="page__title" tabIndex={-1}>
          Account
        </h1>
        <p className="page__lede">Sign in to see your sign-ins, your API keys and the apps that use gitring as you.</p>
        <div className="acct-signin">
          <SignInChoices />
        </div>
      </div>
    );
  }
  const u = me.user;
  return (
    <div className="page acct">
      <p className="page__eyebrow">
        <Icon name="human" size={14} /> Account
      </p>
      <div className="acct-profile">
        {u.avatar ? <img className="acct-profile__avatar" src={u.avatar} alt="" width={56} height={56} referrerPolicy="no-referrer" /> : <span className="acct-profile__avatar acct-profile__avatar--none"><Icon name="human" size={24} /></span>}
        <div className="acct-profile__text">
          <h1 className="page__title" tabIndex={-1}>
            {u.name}
          </h1>
          <p className="acct-profile__meta">
            {u.email ? `${u.email} · ` : ""}
            {/* The id names this person in GITRING_OWNERS ("user:<id>") and in project invites. */}
            Account id <span className="code-inline">{u.id}</span>
            {u.admin ? " · administrator of this gitring" : ""}
          </p>
        </div>
        <div className="acct-profile__acts">
          <Button icon="sign-out" onClick={() => void signOut()}>
            Sign out
          </Button>
          <InlineConfirm
            label="Sign out everywhere"
            ariaLabel="Sign out on every device"
            consequence="Every browser signs out. API keys and connected apps keep working."
            confirmLabel="Sign out everywhere"
            onConfirm={() => signOutEverywhere()}
          />
        </div>
      </div>
      <Passkeys now={now} />
      <SignInMethods />
      <ConnectedApps now={now} />
      <ApiKeys now={now} />
    </div>
  );
}
