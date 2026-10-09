import { useEffect, useState } from "react";
import { Button, CodeBlock, EmptyState, Field, Input, Segmented, toast } from "../design/components";
import { Icon } from "../design/icons";
import type { MemberInfo, Role, Visibility } from "../../../src/core/accounts";
import type { CheckSettings } from "../../../src/core/types";
import { addMember, archiveProject, getSettings, listMembers, loadProjects, putSettings, removeMember, updateProject, useAccess } from "../state/account";
import { useStore } from "../state/store";
import { navigate } from "../app/router";
import "./projects.css";

export function SettingsView() {
  const access = useAccess();
  const projectId = useStore((s) => s.projectId);
  const project = useStore((s) => s.state?.project);
  const info = useStore((s) => s.projects.find((p) => p.id === s.projectId));
  const owner = access === "owner";
  const [members, setMembers] = useState<MemberInfo[] | null>(null);
  const [who, setWho] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [name, setName] = useState(info?.name ?? project?.name ?? "");
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (access === "owner" || access === "member") listMembers(projectId).then(setMembers, () => setMembers([]));
  }, [projectId, access]);
  useEffect(() => setName(info?.name ?? project?.name ?? ""), [info?.name, project?.name]);

  if (!access || access === "viewer") {
    return (
      <div className="page">
        <h1 className="page__title" tabIndex={-1}>
          Project settings
        </h1>
        <EmptyState text="Only members of this project see its settings." />
      </div>
    );
  }

  const run = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key);
    try {
      await fn();
      toast({ tone: "info", title: done });
    } catch (e) {
      toast({ tone: "danger", title: "The change did not save", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const visibility: Visibility = info?.visibility ?? "private";
  const isSample = projectId === "demo";

  return (
    <div className="page settings">
      <p className="page__eyebrow">
        <Icon name="info" size={14} /> Settings
      </p>
      <h1 className="page__title" tabIndex={-1}>
        {info?.name ?? project?.name ?? projectId}
      </h1>
      <p className="page__lede">
        Project id <span className="voice-agent">{projectId}</span>
        {project?.repo.remote ? (
          <>
            {" "}
            · main lives in Cloudflare Artifacts (<span className="voice-agent">{project.repo.name}</span>, branch {project.repo.defaultBranch})
          </>
        ) : null}
      </p>

      <section className="st-sec" aria-labelledby="st-general">
        <h2 className="page__h2" id="st-general">
          General
        </h2>
        <div className="st-row">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} disabled={!owner} maxLength={80} />
          </Field>
          {owner && (
            <Button busy={busy === "name"} onClick={() => void run("name", () => updateProject(projectId, { name }).then(() => loadProjects()), "Name saved")}>
              Save name
            </Button>
          )}
        </div>
        <Segmented<Visibility>
          label="Who can see it"
          value={visibility}
          onChange={(v) => owner && void run("vis", () => updateProject(projectId, { visibility: v }).then(() => loadProjects()), v === "public" ? "The project is public" : "The project is private")}
          options={[
            { value: "private", label: "Private", icon: "eye" },
            { value: "public", label: "Public", icon: "waves" },
          ]}
        />
        <p className="np__help">{visibility === "private" ? "Only members see this project." : "Anyone with the link can watch. Only members can act."}</p>
      </section>

      <section className="st-sec" aria-labelledby="st-members">
        <h2 className="page__h2" id="st-members">
          Members
        </h2>
        <p className="np__help">Owners change settings and members. Members open intents, launch agents and pick attempts. Viewers watch.</p>
        <ul className="st-members">
          {(members ?? []).map((m) => (
            <li key={m.handle}>
              <span className="st-members__name">{m.name}</span>
              <span className="st-members__handle voice-agent">{m.handle}</span>
              <span className="st-members__role">{m.pending ? `${m.role} · invited` : m.role}</span>
              {owner && (
                <Button size="sm" variant="ghost" icon="close" onClick={() => void run(`rm:${m.handle}`, () => removeMember(projectId, m.userId ?? m.handle).then(setMembers), "Member removed")}>
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
        {owner && (
          <div className="st-row">
            <Field label="Add a person" help="A GitHub login or an email. They get the role when they sign in.">
              <Input value={who} onChange={(e) => setWho(e.target.value)} placeholder="octocat or ada@example.com" autoComplete="off" spellCheck={false} />
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
            <Button
              variant="primary"
              icon="plus"
              busy={busy === "add"}
              disabled={!who.trim()}
              onClick={() =>
                void run(
                  "add",
                  () =>
                    addMember(projectId, who.trim(), role).then((list) => {
                      setMembers(list);
                      setWho("");
                    }),
                  "Person added",
                )
              }
            >
              Add
            </Button>
          </div>
        )}
      </section>

      <ChecksSection projectId={projectId} owner={owner} />

      {project?.repo.remote && (
        <section className="st-sec" aria-labelledby="st-repo">
          <h2 className="page__h2" id="st-repo">
            Repository
          </h2>
          <p className="np__help">The canonical repository. Only Bearing writes its main branch: agents and people land work through intents.</p>
          <CodeBlock label="Artifacts remote" code={project.repo.remote} copyLabel="Copy remote" />
        </section>
      )}

      {owner && !isSample && (
        <section className="st-sec st-danger" aria-labelledby="st-danger">
          <h2 className="page__h2" id="st-danger">
            Archive
          </h2>
          <p className="np__help">The project leaves every list. Its repository stays in Artifacts.</p>
          <Button
            variant="danger"
            busy={busy === "archive"}
            onClick={() => {
              if (!confirm(`Archive ${info?.name ?? projectId}?`)) return;
              void run(
                "archive",
                () =>
                  archiveProject(projectId).then(() => {
                    navigate("/projects?project=demo");
                    location.reload();
                  }),
                "Project archived",
              );
            }}
          >
            Archive project
          </Button>
        </section>
      )}
    </div>
  );
}

/** How checks run: the Bearing harness (Dynamic Worker) or the project's own commands in a container. */
function ChecksSection({ projectId, owner }: { projectId: string; owner: boolean }) {
  const [cs, setCs] = useState<CheckSettings | null>(null);
  const [install, setInstall] = useState("");
  const [test, setTest] = useState("");
  const [timeout, setTimeoutSec] = useState("600");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getSettings(projectId).then(
      (s) => {
        const c = s.checks ?? { runner: "worker" };
        setCs(c);
        setInstall(c.install ?? "");
        setTest(c.test ?? "");
        setTimeoutSec(String(c.timeoutSec ?? 600));
      },
      () => setCs(null),
    );
  }, [projectId]);

  if (!cs) return null;
  const save = async (next: CheckSettings) => {
    setBusy(true);
    try {
      const s = await putSettings(projectId, { checks: next });
      setCs(s.checks ?? next);
      toast({ tone: "info", title: "Check settings saved", text: "The next check run uses them." });
    } catch (e) {
      toast({ tone: "danger", title: "The change did not save", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const container = cs.runner === "container";
  return (
    <section className="st-sec" aria-labelledby="st-checks">
      <h2 className="page__h2" id="st-checks">
        Checks
      </h2>
      <p className="np__help">
        Bearing runs the checks before an attempt is ready and again on main plus the attempt before it lands. Work lands only when they pass.
      </p>
      <Segmented<CheckSettings["runner"]>
        label="Where checks run"
        value={cs.runner}
        onChange={(runner) => owner && void save({ ...cs, runner })}
        options={[
          { value: "container", label: "Container", icon: "anchor" },
          { value: "worker", label: "Bearing harness", icon: "compass" },
        ]}
      />
      <p className="np__help">
        {container
          ? "A Linux container with Node.js 24 runs the install command, then the test command. The container reaches package registries only."
          : "A Dynamic Worker runs tests/*.test.js with the Bearing test harness. No dependencies and no network. The sample uses it."}
      </p>
      {container && (
        <>
          <div className="st-row">
            <Field label="Install command" optional help="Empty: npm ci with a package-lock.json, else npm install.">
              <Input className="voice-agent" value={install} onChange={(e) => setInstall(e.target.value)} placeholder="npm ci" disabled={!owner} spellCheck={false} />
            </Field>
            <Field label="Test command" optional help="Empty: npm test. Exit code 0 means the checks pass.">
              <Input className="voice-agent" value={test} onChange={(e) => setTest(e.target.value)} placeholder="npm test" disabled={!owner} spellCheck={false} />
            </Field>
            <Field label="Time limit (s)" help="60 to 1800.">
              <Input value={timeout} onChange={(e) => setTimeoutSec(e.target.value)} inputMode="numeric" disabled={!owner} />
            </Field>
          </div>
          {owner && (
            <div>
              <Button busy={busy} onClick={() => void save({ runner: "container", install: install.trim() || undefined, test: test.trim() || undefined, timeoutSec: Number(timeout) || 600 })}>
                Save check commands
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
