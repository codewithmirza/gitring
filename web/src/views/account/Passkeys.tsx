/**
 * The passkeys of the person: the list, add a passkey, rename and remove. A passkey needs no outside account.
 */
import { useRef, useState, type FormEvent } from "react";
import type { PasskeyInfo } from "../../../../src/core/accounts";
import { Button, InlineConfirm, Input, SkeletonRows } from "../../design/components";
import { Icon } from "../../design/icons";
import { loadMe, useMe } from "../../state/account";
import { useResource } from "../../state/connections";
import { addPasskey, listPasskeys, passkeyErrorText, passkeysWork, PasskeyStopped, removePasskey, renamePasskey } from "../../state/passkey";
import { ago } from "../../state/format";
import { dateText } from "./format";

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

export function Passkeys({ now }: { now: number }) {
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
        <SkeletonRows rows={1} label="Please wait for your passkeys" />
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
