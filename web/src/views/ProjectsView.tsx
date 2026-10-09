import { useEffect, useMemo, useState } from "react";
import { Button, Dialog, EmptyState, Field, Input, Segmented, toast } from "../design/components";
import { Icon, type IconName } from "../design/icons";
import type { ProjectInfo, Visibility } from "../../../src/core/accounts";
import type { ProjectSource } from "../../../src/core/types";
import { createProject, loadProjects, openProject, useMe } from "../state/account";
import { useStore } from "../state/store";
import { setSearchParam, useSearchParam } from "../app/router";
import { setUi } from "../app/ui";
import "./projects.css";

type Kind = "sample" | "empty" | "git";

const KINDS: { value: Kind; label: string; icon: IconName; help: string }[] = [
  { value: "sample", label: "Sample", icon: "compass", help: "A small bookshop on Cloudflare Workers with five intents and checks. Your own copy, to try real AI agents." },
  { value: "empty", label: "Empty", icon: "anchor", help: "A new repository with a README. Push code to it or let agents write it." },
  { value: "git", label: "Import", icon: "fork", help: "Import a public repository from GitHub, GitLab, Bitbucket or any https git host. The history comes with it." },
];

function sourceLine(p: ProjectInfo): string {
  const s = p.source;
  if (s.kind === "git") return `Imported from ${s.url.replace(/^https:\/\//, "")}${s.branch ? ` (${s.branch})` : ""}`;
  if (s.kind === "sample") return "Sample project";
  if (s.kind === "empty") return "Started empty";
  return s.kind;
}

function repoName(url: string): string {
  const m = /([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? m[1].replace(/[-_]+/g, " ") : "";
}

function NewProjectDialog({ open, onClose, initial }: { open: boolean; onClose: () => void; initial: Kind }) {
  const [kind, setKind] = useState<Kind>(initial);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [visibility, setVisibility] = useState<Visibility>("private");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setKind(initial);
      setError(null);
    }
  }, [open, initial]);

  const suggested = kind === "sample" ? "Saltmarsh Books" : kind === "git" ? repoName(url) : "";
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const source: ProjectSource = kind === "git" ? { kind: "git", url: url.trim(), ...(branch.trim() ? { branch: branch.trim() } : {}) } : { kind };
      const p = await createProject({ name: (name.trim() || suggested || "New project").slice(0, 80), visibility, source });
      toast({ tone: "info", title: "Project ready", text: kind === "git" ? "Artifacts imports the repository now. The chart fills when it is done." : `${p.name} is open.` });
      openProject(p.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New project"
      description="Bearing keeps the code in Cloudflare Artifacts: main, one fork per agent, and the logbook."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon="plus" busy={busy} onClick={() => void submit()} disabled={kind === "git" && !url.trim()}>
            Create project
          </Button>
        </>
      }
    >
      <div className="np">
        <Segmented<Kind>
          label="Where the code comes from"
          value={kind}
          onChange={setKind}
          options={KINDS.map((k) => ({ value: k.value, label: k.label, icon: k.icon }))}
        />
        <p className="np__help">{KINDS.find((k) => k.value === kind)?.help}</p>
        {kind === "git" && (
          <>
            <Field label="Repository URL" help="An https URL, for example https://github.com/owner/repo. Private repositories come in the next release of Bearing.">
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/owner/repo" inputMode="url" autoComplete="off" spellCheck={false} data-autofocus />
            </Field>
            <Field label="Branch" optional help="Leave it empty to use the default branch.">
              <Input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" autoComplete="off" spellCheck={false} />
            </Field>
          </>
        )}
        <Field label="Name" optional>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={suggested || "My project"} maxLength={80} />
        </Field>
        <Segmented<Visibility>
          label="Who can see it"
          value={visibility}
          onChange={setVisibility}
          options={[
            { value: "private", label: "Private", icon: "eye" },
            { value: "public", label: "Public", icon: "waves" },
          ]}
        />
        <p className="np__help">{visibility === "private" ? "Only you and the people you add." : "Anyone with the link can watch. Only members can act."}</p>
        {error && (
          <p className="np__error" role="alert">
            <Icon name="cross" size={12} /> {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

export function ProjectsView() {
  const me = useMe();
  const projects = useStore((s) => s.projects);
  const current = useStore((s) => s.projectId);
  const asked = useSearchParam("new");
  const [open, setOpen] = useState(false);
  const initial: Kind = asked === "sample" ? "sample" : asked === "git" || asked === "github" ? "git" : asked === "empty" ? "empty" : "sample";
  const signedIn = Boolean(me?.user);

  useEffect(() => {
    void loadProjects().catch(() => undefined);
  }, []);
  useEffect(() => {
    if (asked && signedIn) setOpen(true);
  }, [asked, signedIn]);

  const [mine, others] = useMemo(() => {
    const a = projects.filter((p) => p.role === "owner" || p.role === "member");
    const b = projects.filter((p) => p.role === "viewer");
    return [a, b];
  }, [projects]);

  const close = () => {
    setOpen(false);
    setSearchParam("new", null);
  };

  return (
    <div className="page projects">
      <p className="page__eyebrow">
        <Icon name="grid" size={14} /> Projects
      </p>
      <h1 className="page__title" tabIndex={-1}>
        Projects
      </h1>
      <p className="page__lede">Each project is one repository in Cloudflare Artifacts. Agents work on it at the same time; Bearing keeps them apart.</p>
      <div className="projects__actions">
        {signedIn ? (
          <Button variant="primary" icon="plus" onClick={() => setOpen(true)}>
            New project
          </Button>
        ) : (
          <Button variant="primary" icon="human" onClick={() => setUi({ signIn: true })}>
            Sign in to make a project
          </Button>
        )}
      </div>

      {signedIn && (
        <section aria-labelledby="pj-mine">
          <h2 className="page__h2" id="pj-mine">
            Your projects
          </h2>
          {mine.length ? (
            <ProjectGrid list={mine} current={current} />
          ) : (
            <EmptyState text="You have no project yet. Make one from the sample, from scratch, or import a repository." />
          )}
        </section>
      )}
      <section aria-labelledby="pj-public">
        <h2 className="page__h2" id="pj-public">
          Public projects
        </h2>
        {others.length ? <ProjectGrid list={others} current={current} /> : <EmptyState text="No public projects." />}
      </section>
      {signedIn && <NewProjectDialog open={open} onClose={close} initial={initial} />}
    </div>
  );
}

function ProjectGrid({ list, current }: { list: ProjectInfo[]; current: string }) {
  return (
    <ul className="pj-grid">
      {list.map((p) => (
        <li key={p.id}>
          <button type="button" className={["pj-card", p.id === current && "is-current"].filter(Boolean).join(" ")} onClick={() => openProject(p.id)}>
            <span className="pj-card__top">
              <Icon name={p.source.kind === "git" ? "fork" : p.source.kind === "sample" ? "compass" : "anchor"} />
              <span className="pj-card__name">{p.name}</span>
            </span>
            <span className="pj-card__source">{sourceLine(p)}</span>
            <span className="pj-card__meta">
              {p.visibility} · {p.role}
              {p.ownerName ? ` · ${p.ownerName}` : ""}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
