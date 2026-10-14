/**
 * The step for a starter template: the name, the template and who can see the project, then create it.
 */
import { useId, useState, type FormEvent } from "react";
import type { Visibility } from "../../../../../src/core/accounts";
import { TEMPLATES, type TemplateId } from "../../../../../src/core/templates";
import { Segmented } from "../../../design/components";
import { openProject } from "../../../state/account";
import { RequestError } from "../../../state/github";
import { createProjectFrom } from "../../../state/projects";
import { createProblem, Problem, Quiet, Row, StepHead, type StepProps, Submit, TEMPLATE_OPTIONS, toError, useFirstField, VisibilityRow } from "./shared";

export function TemplateStep({ form, setForm, onBack, onStep, returnTo }: StepProps) {
  const uid = useId().replace(/:/g, "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<RequestError | null>(null);
  const first = useFirstField();
  const template = (form.template as TemplateId | undefined) ?? "js-library";
  const v = { name: form.name ?? "New project", visibility: form.visibility ?? ("private" as Visibility) };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const project = await createProjectFrom({ name: v.name.trim() || "New project", visibility: v.visibility, source: { kind: "template", template } });
      openProject(project.id);
    } catch (err) {
      setError(toError(err));
      setBusy(false);
    }
  };

  const problem = error ? createProblem(error, returnTo, onStep) : null;
  return (
    <form className="np-step" onSubmit={submit} noValidate>
      <StepHead title="Start from a template" onBack={onBack} />
      <p className="np-step__note">The template is the first commit. Its tests run in the gitring test runner, so the first merge already runs tests.</p>
      <div className="np-rows">
        <Row id={`${uid}-name`} label="Name">
          <Quiet id={`${uid}-name`} value={v.name} onChange={(name) => setForm({ name })} maxLength={80} inputRef={first} placeholder="New project" />
        </Row>
        <div className="np-row">
          <span className="np-row__label">Template</span>
          <div className="np-row__value">
            <Segmented<TemplateId> label="Template" value={template} onChange={(t) => setForm({ template: t })} options={TEMPLATE_OPTIONS} />
            <span className="np-row__hint">{TEMPLATES.find((t) => t.id === template)?.summary}</span>
          </div>
        </div>
        <VisibilityRow value={v.visibility} onChange={(visibility) => setForm({ visibility })} />
      </div>
      {problem && <Problem actions={problem.actions}>{problem.text}</Problem>}
      <Submit busy={busy} label={busy ? "Please wait…" : "Create project"} />
    </form>
  );
}
