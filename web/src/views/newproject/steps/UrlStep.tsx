/**
 * The step for a public git URL: the URL, the name, the branch and who can see the project, then create it.
 */
import { useId, useState, type FormEvent } from "react";
import type { Visibility } from "../../../../../src/core/accounts";
import { openProject } from "../../../state/account";
import { RequestError } from "../../../state/github";
import { createProjectFrom } from "../../../state/projects";
import type { SourceStep } from "../draft";
import { nameOfUrl, readPasted, validBranch } from "../match";
import { createProblem, Problem, Quiet, Row, StepHead, type StepProps, Submit, toError, useFirstField, VisibilityRow } from "./shared";

export function UrlStep({ step, form, setForm, onBack, onStep, returnTo }: StepProps & { step: Extract<SourceStep, { kind: "git" }> }) {
  const uid = useId().replace(/:/g, "");
  const url = form.url ?? step.url;
  const read = readPasted(url);
  const okUrl = read?.kind === "git" ? read.url : read?.kind === "github" ? read.url : null;
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<RequestError | null>(null);
  // A pasted URL: the name takes the focus. "Import from a git URL" opens with no URL: the URL field does.
  const first = useFirstField();
  const v = {
    name: form.name ?? nameOfUrl(okUrl ?? url),
    branch: form.branch ?? "",
    visibility: form.visibility ?? ("public" as Visibility),
  };
  const badUrl = tried && !okUrl;
  const badBranch = tried && v.branch.trim() !== "" && !validBranch(v.branch.trim());

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (!okUrl || busy) return;
    const branch = v.branch.trim();
    if (branch && !validBranch(branch)) return;
    setBusy(true);
    setError(null);
    try {
      const project = await createProjectFrom({
        name: v.name.trim() || nameOfUrl(okUrl) || "New project",
        visibility: v.visibility,
        source: { kind: "git", url: okUrl, ...(branch ? { branch } : {}) },
      });
      openProject(project.id);
    } catch (err) {
      setError(toError(err));
      setBusy(false);
    }
  };

  const problem = error ? createProblem(error, returnTo, onStep) : null;
  return (
    <form className="np-step" onSubmit={submit} noValidate>
      <StepHead title="Import a public repository" onBack={onBack} />
      {step.note && <p className="np-step__note">{step.note}</p>}
      <div className="np-rows">
        <Row id={`${uid}-url`} label="URL" hint={badUrl ? "Give an https URL of a git repository, for example https://gitlab.com/owner/repo." : "Public repositories only. For a private one, push with git."}>
          <Quiet
            id={`${uid}-url`}
            value={url}
            onChange={(u) => setForm({ url: u })}
            mono
            hint
            invalid={badUrl}
            inputMode="url"
            placeholder="https://codeberg.org/owner/repo"
            inputRef={step.url ? undefined : first}
          />
        </Row>
        <Row id={`${uid}-name`} label="Name">
          <Quiet id={`${uid}-name`} value={v.name} onChange={(name) => setForm({ name })} maxLength={80} inputRef={step.url ? first : undefined} />
        </Row>
        <Row id={`${uid}-branch`} label="Branch" hint={badBranch ? "Use letters, digits, dots, dashes and slashes." : "Empty: the default branch."}>
          <Quiet id={`${uid}-branch`} value={v.branch} onChange={(branch) => setForm({ branch })} mono hint invalid={badBranch} placeholder="default branch" />
        </Row>
        <VisibilityRow value={v.visibility} onChange={(visibility) => setForm({ visibility })} hint={form.visibility === undefined ? "Same as the repository." : undefined} />
      </div>
      {problem && <Problem actions={problem.actions}>{problem.text}</Problem>}
      <p className="np-step__note">Cloudflare Artifacts imports the repository with its history. A large repository takes some minutes.</p>
      <Submit busy={busy} label={busy ? "Please wait…" : "Create project"} />
    </form>
  );
}
