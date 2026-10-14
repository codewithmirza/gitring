/**
 * The personal API keys: the list, a new key (it shows one time only) and a revoke button.
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ApiKeyInfo } from "../../../../src/core/accounts";
import { Button, CodeBlock, InlineConfirm, Input, SkeletonRows } from "../../design/components";
import { Icon } from "../../design/icons";
import { useMe } from "../../state/account";
import { createKey, listKeys, revokeKey, useResource } from "../../state/connections";
import { ago } from "../../state/format";
import { dateText } from "./format";

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
        <span className="acct-row__meta">Created {dateText(k.createdAt)}</span>
        <span className="acct-row__meta">{k.lastUsed ? `Last used ${ago(k.lastUsed, now)}` : "Not used yet"}</span>
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

export function ApiKeys({ now }: { now: number }) {
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
        <SkeletonRows rows={2} label="Please wait for the API keys" />
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
