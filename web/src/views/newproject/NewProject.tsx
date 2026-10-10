/**
 * New project: one combobox for every source, then one short step with gitring's guesses and one
 * "Create project" button. The same content shows in the panel of the "New project" button and, for a
 * person without projects, right on the page.
 */
import { useRef, type ChangeEvent, type Dispatch, type SetStateAction } from "react";
import type { MeWithInstall } from "../../state/account";
import { SignInChoices } from "../../app/Account";
import type { FormValues, NewProjectDraft, SourceStep } from "./draft";
import { SourceList, type SourceOption } from "./SourceList";
import { GithubStep, PlainStep, UploadStep, UrlStep } from "./steps";
import "./newproject.css";

interface NewProjectProps {
  me: MeWithInstall | null;
  draft: NewProjectDraft;
  onDraft: Dispatch<SetStateAction<NewProjectDraft>>;
  /** id of the heading (the panel is labelled by it). */
  headingId: string;
  /** The page that sign-in and "Connect GitHub" come back to. */
  returnTo: string;
  /** Focus the search field when the list shows. */
  autoFocus?: boolean;
  title?: string;
  /** One sentence under the title (the page version). */
  lede?: string;
}

export function NewProject({ me, draft, onDraft, headingId, returnTo, autoFocus = true, title = "New project", lede }: NewProjectProps) {
  const folder = useRef<HTMLInputElement | null>(null);
  const step = draft.step;

  const setForm = (patch: Partial<FormValues>) => onDraft((d) => ({ ...d, form: { ...d.form, ...patch } }));
  const go = (s: SourceStep) => onDraft((d) => ({ ...d, step: s, form: {} }));
  const back = () => onDraft((d) => ({ ...d, step: { kind: "list" }, form: {} }));
  const chooseFolder = () => folder.current?.click();

  const pick = (o: SourceOption) => {
    switch (o.kind) {
      case "repo":
        go({ kind: "github", repo: o.repo.fullName, known: o.repo });
        break;
      case "import-github":
        go({ kind: "github", repo: o.repo, known: o.known });
        break;
      case "import-git":
        go({ kind: "git", url: o.url });
        break;
      case "upload":
        chooseFolder();
        break;
      case "push":
      case "empty":
        go({ kind: o.kind });
        break;
      default:
        break;
    }
  };

  const onFiles = (e: ChangeEvent<HTMLInputElement>) => {
    const list = [...(e.target.files ?? [])];
    // Let the same folder fire a change again later.
    e.target.value = "";
    if (!list.length) return;
    const rel = (list[0] as File & { webkitRelativePath?: string }).webkitRelativePath ?? "";
    onDraft((d) => ({ ...d, step: { kind: "upload" }, form: {}, upload: { files: list, folder: rel.split("/")[0] ?? "" } }));
  };

  const back$ = `${returnTo}${returnTo.includes("?") ? "&" : "?"}`;
  const stepReturn =
    step.kind === "github" ? `${back$}repo=${encodeURIComponent(step.repo)}` : step.kind === "list" ? returnTo : `${back$}new=${step.kind === "git" ? `git&url=${encodeURIComponent(step.url)}` : step.kind}`;
  const stepProps = { form: draft.form, setForm, onBack: back, onStep: go, returnTo: stepReturn };

  return (
    <div className="np">
      <h2 id={headingId} className="np__title">
        {title}
      </h2>
      {lede && me?.user && draft.step.kind === "list" && <p className="np__lede">{lede}</p>}
      {!me ? (
        <div className="np-wait" aria-hidden="true">
          <span className="np-skel" style={{ width: "100%", height: 36 }} />
        </div>
      ) : !me.user ? (
        <SignInChoices
          returnTo={returnTo}
          reason={`Sign in to make a project.${me.providers.github ? " With GitHub, gitring also shows your repositories, private ones too." : ""}`}
        />
      ) : step.kind === "list" ? (
        <SourceList me={me} query={draft.query} onQuery={(query) => onDraft((d) => ({ ...d, query }))} onPick={pick} returnTo={returnTo} autoFocus={autoFocus} />
      ) : step.kind === "github" ? (
        <GithubStep key={step.repo} step={step} {...stepProps} />
      ) : step.kind === "git" ? (
        <UrlStep key={step.url} step={step} {...stepProps} />
      ) : step.kind === "upload" ? (
        <UploadStep upload={draft.upload} onChooseFolder={chooseFolder} {...stepProps} />
      ) : (
        <PlainStep key={step.kind} kind={step.kind} {...stepProps} />
      )}
      <input
        ref={folder}
        type="file"
        hidden
        multiple
        tabIndex={-1}
        aria-hidden="true"
        // @ts-expect-error: webkitdirectory is a non-standard attribute that all current browsers support.
        webkitdirectory=""
        onChange={onFiles}
      />
    </div>
  );
}
