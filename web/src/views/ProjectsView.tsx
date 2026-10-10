import { useEffect, useMemo, useState } from "react";
import { Button, Dialog, EmptyState, Field, Input, Segmented, toast } from "../design/components";
import { Icon, type IconName } from "../design/icons";
import type { ProjectInfo, Visibility } from "../../../src/core/accounts";
import type { ProjectSource } from "../../../src/core/types";
import { createProject, loadProjects, openProject, readUpload, uploadable, useMe } from "../state/account";
import { useStore } from "../state/store";
import { setSearchParam, useSearchParam } from "../app/router";
import { setUi } from "../app/ui";
import "./projects.css";

type Kind = "sample" | "empty" | "git" | "push" | "upload";

/** Real sources first; the sample is last. */
const KINDS: { value: Kind; label: string; icon: IconName; help: string }[] = [
  { value: "git", label: "Import URL", icon: "fork", help: "Import a public repository from GitHub, GitLab, Bitbucket or any https git host. The history comes with it." },
  { value: "push", label: "git push", icon: "launch", help: "For private repositories from any host: gitring makes an empty repository, then you push yours to it with git. The history comes with it." },
  { value: "upload", label: "Folder", icon: "grid", help: "Upload a folder from your computer, without git. gitring leaves out .git, node_modules and build output." },
  { value: "empty", label: "Empty", icon: "anchor", help: "A new repository with a README. Agents write the code." },
  { value: "sample", label: "Sample", icon: "compass", help: "Your own copy of a small bookshop on Cloudflare Workers, with five tasks and their tests. Use it to try the agents." },
];

function mb(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} KB`;
}

function sourceLine(p: ProjectInfo): string {
  const s = p.source;
  if (s.kind === "git") return `Imported from ${s.url.replace(/^https:\/\//, "")}${s.branch ? ` (${s.branch})` : ""}`;
  if (s.kind === "sample") return "Sample project";
  if (s.kind === "empty") return "Started empty";
  if (s.kind === "upload") return `Uploaded folder (${s.files} files)`;
  if (s.kind === "push") return "Pushed with git";
  return "Project";
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
  const [picked, setPicked] = useState<{ files: File[]; folder: string } | null>(null);
  const plan = useMemo(() => (picked ? uploadable(picked.files) : null), [picked]);

  useEffect(() => {
    if (open) {
      setKind(initial);
      setError(null);
    }
  }, [open, initial]);

  const suggested = kind === "sample" ? "Saltmarsh Books" : kind === "git" ? repoName(url) : kind === "upload" ? (picked?.folder ?? "") : "";
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const source: ProjectSource =
        kind === "git"
          ? { kind: "git", url: url.trim(), ...(branch.trim() ? { branch: branch.trim() } : {}) }
          : kind === "upload"
            ? { kind: "upload", files: plan?.keep.length ?? 0 }
            : { kind };
      const files = kind === "upload" && plan ? await readUpload(plan.keep) : undefined;
      const p = await createProject({ name: (name.trim() || suggested || "New project").slice(0, 80), visibility, source, files });
      toast({
        tone: "info",
        title: "Project ready",
        text:
          kind === "git"
            ? "Artifacts imports the repository now. The overview fills when it is done."
            : kind === "push"
              ? "Push your repository now. The overview shows the commands."
              : `${p.name} is open.`,
      });
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
      description="gitring keeps the code in Cloudflare Artifacts: main, one work copy per agent, and the history."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon="plus" busy={busy} onClick={() => void submit()} disabled={(kind === "git" && !url.trim()) || (kind === "upload" && !plan?.keep.length)}>
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
        {kind === "upload" && (
          <Field label="Folder" help="gitring reads the files in your browser and sends them in one commit (at most 20 MB).">
            <input
              type="file"
              className="np__folder"
              // @ts-expect-error: webkitdirectory is a non-standard attribute that all current browsers support.
              webkitdirectory=""
              multiple
              onChange={(e) => {
                const list = [...(e.target.files ?? [])];
                const first = (list[0] as (File & { webkitRelativePath?: string }) | undefined)?.webkitRelativePath?.split("/")[0] ?? "";
                setPicked(list.length ? { files: list, folder: first } : null);
              }}
            />
          </Field>
        )}
        {kind === "upload" && plan && (
          <p className="np__help">
            {plan.keep.length} files, {mb(plan.bytes)}.{plan.skipped ? ` ${plan.skipped} files stay out (dependencies, build output, .git, or larger than 5 MB).` : ""}
            {plan.bytes > 20_000_000 ? " The folder is larger than 20 MB: use git push instead." : ""}
          </p>
        )}
        {kind === "git" && (
          <>
            <Field label="Repository URL" help="An https URL, for example https://github.com/owner/repo. For a private repository, use git push.">
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
        <p className="np__help">{visibility === "private" ? "Only you and the people you add." : "Anyone with the link can view it. Only members can change it."}</p>
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
  const initial: Kind =
    asked === "sample" ? "sample" : asked === "empty" ? "empty" : asked === "push" ? "push" : asked === "upload" || asked === "folder" ? "upload" : "git";
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
      <p className="page__lede">Each project is one repository in Cloudflare Artifacts. Many agents work on it at the same time. gitring keeps their work apart.</p>
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
            <EmptyState text="You have no project yet. Import a repository, push one with git, or upload a folder." />
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
