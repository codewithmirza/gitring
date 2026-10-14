/**
 * The "/account" page: the person, with the profile, the sign-out buttons and one section for each part of the account.
 *
 * The sections are: where the person answers merge questions, passkeys, the other sign-ins (Google, GitHub and the GitHub
 * connection), the apps allowed through OAuth (Claude, Claude Code, Cursor, Codex), and personal API keys.
 * Destructive actions confirm in place; nothing opens a modal. Read next: account/.
 */
import { Button, InlineConfirm, SkeletonRows } from "../design/components";
import { Icon } from "../design/icons";
import { useMe, signOut, signOutEverywhere } from "../state/account";
import { useNow } from "../app/useNow";
import { SignInChoices } from "../app/Account";
import { AnswersIn } from "./account/AnswersIn";
import { ApiKeys } from "./account/ApiKeys";
import { ConnectedApps } from "./account/ConnectedApps";
import { Passkeys } from "./account/Passkeys";
import { SignInMethods } from "./account/SignInMethods";
import "./account.css";

export function AccountView() {
  const me = useMe();
  const now = useNow(30_000);
  if (!me) {
    return (
      <div className="page acct">
        <h1 className="page__title" tabIndex={-1}>
          Account
        </h1>
        <SkeletonRows rows={4} label="Please wait for your account" />
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
            consequence="Every browser signs out. API keys and connected apps stay valid."
            confirmLabel="Sign out everywhere"
            onConfirm={() => signOutEverywhere()}
          />
        </div>
      </div>
      <AnswersIn />
      <Passkeys now={now} />
      <SignInMethods />
      <ConnectedApps now={now} />
      <ApiKeys now={now} />
    </div>
  );
}
