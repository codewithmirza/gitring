/**
 * The Members settings: who is in the project, with a role each, and a form to add a person (owners only).
 * A fact has its own place: the name carries "You" and "Invited" as badges, and the role has its own column.
 */
import { useRef, useState } from "react";
import { Badge, Button, Field, InlineConfirm, Input, Segmented, toast } from "../../design/components";
import type { MemberInfo, Role } from "../../../../src/core/accounts";
import { addMember, removeMember } from "../../state/account";
import { type RunSave } from "./shared";

interface Props {
  projectId: string;
  owner: boolean;
  /** The id of the signed-in person, to mark that row. */
  meId: string | undefined;
  members: MemberInfo[] | null;
  onMembers: (list: MemberInfo[]) => void;
  busy: string | null;
  run: RunSave;
}

const roleText = (role: Role) => role.charAt(0).toUpperCase() + role.slice(1);

export function MembersSection({ projectId, owner, meId, members, onMembers, busy, run }: Props) {
  const [who, setWho] = useState("");
  const [role, setRole] = useState<Role>("member");
  const head = useRef<HTMLHeadingElement | null>(null);

  const remove = async (m: MemberInfo) => {
    try {
      onMembers(await removeMember(projectId, m.userId ?? m.handle));
      toast({ tone: "info", title: "Member removed", text: `${m.name} has no access now.` });
      head.current?.setAttribute("tabindex", "-1");
      head.current?.focus();
    } catch (e) {
      toast({ tone: "danger", title: "The member was not removed", text: (e as Error).message });
    }
  };

  return (
    <section className="st-sec" aria-labelledby="st-members">
      <h2 className="page__h2" id="st-members" ref={head}>
        Members
      </h2>
      <p className="np__help">Owners change settings and members. Members open tasks, start agents and choose work copies. Viewers can only look.</p>
      <ul className="st-members" aria-busy={members === null || undefined}>
        {(members ?? []).map((m) => (
          <li key={m.handle}>
            <span className="st-members__name">
              {m.name}
              {m.userId && m.userId === meId && (
                <Badge tone="neutral" className="st-members__badge">
                  You
                </Badge>
              )}
              {m.pending && (
                <Badge tone="caution" icon="clock" className="st-members__badge">
                  Invited
                </Badge>
              )}
            </span>
            <span className="st-members__handle voice-agent">{m.handle}</span>
            <span className="st-members__role">{roleText(m.role)}</span>
            {owner && m.userId !== meId && (
              <span className="st-members__act">
                <InlineConfirm
                  label="Remove"
                  ariaLabel={`Remove ${m.name}`}
                  size="sm"
                  icon="close"
                  consequence={`Remove ${m.name}? ${m.pending ? "The invitation ends." : "They lose access at once."}`}
                  confirmLabel="Remove"
                  onConfirm={() => remove(m)}
                />
              </span>
            )}
          </li>
        ))}
      </ul>
      {owner && (
        <form
          className="st-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (!who.trim()) return;
            void run(
              "add",
              () =>
                addMember(projectId, who.trim(), role).then((list) => {
                  onMembers(list);
                  setWho("");
                }),
              "Person added",
            );
          }}
        >
          <Field label="Add a person" help="An account id (from the Account page), an email or a GitHub login. An email or a login gets the role at the next sign-in.">
            <Input value={who} onChange={(e) => setWho(e.target.value)} placeholder="u_0123456789 or ada@example.com" autoComplete="off" spellCheck={false} />
          </Field>
          <Segmented<Role>
            label="Role"
            value={role}
            onChange={setRole}
            options={[
              { value: "viewer", label: "Viewer" },
              { value: "member", label: "Member" },
              { value: "owner", label: "Owner" },
            ]}
          />
          <Button type="submit" variant="primary" icon="plus" busy={busy === "add"} disabled={!who.trim()}>
            Add
          </Button>
        </form>
      )}
    </section>
  );
}
