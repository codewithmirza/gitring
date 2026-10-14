/**
 * The step for a folder upload: read the folder in the browser, show what will go up and its size, then create the project.
 */
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import type { Visibility } from "../../../../../src/core/accounts";
import { Button } from "../../../design/components";
import { openProject, readUpload, uploadable } from "../../../state/account";
import { RequestError } from "../../../state/github";
import { createProjectFrom } from "../../../state/projects";
import { sizeText } from "../match";
import { createProblem, Problem, Quiet, Row, StepHead, type StepProps, Submit, toError, useFirstField, VisibilityRow } from "./shared";

const MAX_UPLOAD = 20_000_000;

/* ───────────── folder upload ───────────── */

export function UploadStep({ upload, form, setForm, onBack, onStep, onChooseFolder, returnTo }: StepProps & { upload: { files: File[]; folder: string } | null; onChooseFolder: () => void }) {
  const uid = useId().replace(/:/g, "");
  const plan = useMemo(() => (upload ? uploadable(upload.files) : null), [upload]);
  const [busy, setBusy] = useState<"read" | "create" | null>(null);
  const [error, setError] = useState<RequestError | null>(null);
  const first = useFirstField(Boolean(plan));
  const choose = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!plan) choose.current?.focus({ preventScroll: true });
  }, [plan]);
  const v = { name: form.name ?? upload?.folder ?? "", visibility: form.visibility ?? ("private" as Visibility) };
  const tooBig = Boolean(plan && plan.bytes > MAX_UPLOAD);
  const none = Boolean(plan && plan.keep.length === 0);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!plan || tooBig || none || busy) return;
    setBusy("read");
    setError(null);
    try {
      const files = await readUpload(plan.keep);
      setBusy("create");
      const project = await createProjectFrom({
        name: v.name.trim() || upload?.folder || "New project",
        visibility: v.visibility,
        source: { kind: "upload", files: files.length },
        files,
      });
      openProject(project.id);
    } catch (err) {
      setError(toError(err));
      setBusy(null);
    }
  };

  const problem = error ? createProblem(error, returnTo, onStep) : null;
  return (
    <form className="np-step" onSubmit={submit} noValidate>
      <StepHead title="Upload a folder" onBack={onBack} />
      {plan ? (
        <p className="np-step__note" role="status">
          <span className="voice-agent">{upload?.folder || "Folder"}</span>: {plan.keep.length} {plan.keep.length === 1 ? "file" : "files"}, {sizeText(plan.bytes)}.
          {plan.skipped ? ` ${plan.skipped} files stay out (dependencies, build output, .git, or larger than 5 MB).` : ""}{" "}
          <button type="button" className="np-linkbtn" onClick={onChooseFolder}>
            Choose another folder
          </button>
        </p>
      ) : (
        <div className="np-step__pick">
          <p className="np-step__note">gitring reads the files in your browser and sends them in one commit. It leaves out .git, node_modules and build output.</p>
          <Button ref={choose} icon="launch" onClick={onChooseFolder} data-autofocus>
            Choose a folder
          </Button>
        </div>
      )}
      {tooBig && (
        <Problem
          actions={
            <Button size="sm" onClick={() => onStep({ kind: "push" })}>
              Push with git instead
            </Button>
          }
        >
          The folder is larger than 20 MB. Push it with git.
        </Problem>
      )}
      {none && <Problem>The folder has no files that gitring can upload.</Problem>}
      {plan && (
        <div className="np-rows">
          <Row id={`${uid}-name`} label="Name">
            <Quiet id={`${uid}-name`} value={v.name} onChange={(name) => setForm({ name })} maxLength={80} inputRef={first} placeholder="New project" />
          </Row>
          <VisibilityRow value={v.visibility} onChange={(visibility) => setForm({ visibility })} />
        </div>
      )}
      {problem && <Problem actions={problem.actions}>{problem.text}</Problem>}
      <Submit
        busy={busy !== null}
        label={busy === "read" ? "Please wait…" : busy === "create" ? "Please wait…" : "Create project"}
        disabled={!plan || tooBig || none}
        why={!plan ? "Choose a folder first." : undefined}
      />
    </form>
  );
}
