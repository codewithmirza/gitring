/**
 * The second step of a new project: gitring's guesses for the chosen source, each one on one line and
 * editable in place, and ONE button: "Create project" (Enter).
 */
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { ProjectGuess, Visibility } from "../../../../src/core/accounts";
import type { GithubSyncMode, ProjectSource } from "../../../../src/core/types";
import { Button, Segmented } from "../../design/components";
import { Icon } from "../../design/icons";
import { openProject, readUpload, uploadable } from "../../state/account";
import { cachedGuess, createProjectFrom, githubConnectUrl, guessProject, isAbort, RequestError, useDelayedFlag, OFFLINE_TEXT } from "../../state/github";
import type { FormValues, SourceStep } from "./draft";
import { GithubMark, LockIcon } from "./marks";
import { nameOfRepo, nameOfUrl, readPasted, reasonFor, sizeText, validBranch } from "./match";

const MAX_UPLOAD = 20_000_000;

export interface StepProps {
  form: Partial<FormValues>;
  setForm: (patch: Partial<FormValues>) => void;
  onBack: () => void;
  onStep: (step: SourceStep) => void;
  /** Where a sign-in sends the person back. */
  returnTo: string;
}

const VIS_HELP: Record<Visibility, string> = {
  private: "Only you and the people you add can see it.",
  public: "Anyone with the link can view it. Only members can change it.",
};

const SYNC_TEXT: Record<GithubSyncMode, string> = {
  off: "Merged code stays in gitring. You can turn this on later.",
  "pull-request": "gitring keeps one pull request open on GitHub. You merge it there.",
  main: "gitring pushes each merge straight to the main branch on GitHub.",
};

function toError(e: unknown): RequestError {
  return e instanceof RequestError ? e : new RequestError(0, (e as Error)?.message || OFFLINE_TEXT);
}

/* ───────────── shared parts ───────────── */

function StepHead({ title, onBack, children }: { title: ReactNode; onBack: () => void; children?: ReactNode }) {
  return (
    <div className="np-step__head">
      <button type="button" className="np-back" onClick={onBack}>
        <Icon name="arrow-left" size={14} />
        All sources
      </button>
      <h3 className="np-step__title">{title}</h3>
      {children}
    </div>
  );
}

function Row({ id, label, hint, children }: { id: string; label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="np-row">
      <label className="np-row__label" htmlFor={id}>
        {label}
      </label>
      <div className="np-row__value">
        {children}
        {hint && (
          <span className="np-row__hint" id={`${id}-hint`}>
            {hint}
          </span>
        )}
      </div>
    </div>
  );
}

/** A quiet text field: it reads as a value, and it is a normal input for keys, focus and screen readers. */
function Quiet({ id, value, onChange, placeholder, mono, hint, invalid, inputRef, ...rest }: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  hint?: boolean;
  invalid?: boolean;
  inputRef?: (el: HTMLInputElement | null) => void;
  maxLength?: number;
  inputMode?: "url" | "text";
}) {
  return (
    <input
      {...rest}
      ref={inputRef}
      id={id}
      className={["np-in", mono && "voice-agent"].filter(Boolean).join(" ")}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      aria-describedby={hint ? `${id}-hint` : undefined}
      aria-invalid={invalid || undefined}
      autoComplete="off"
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
    />
  );
}

function VisibilityRow({ value, onChange, hint }: { value: Visibility; onChange: (v: Visibility) => void; hint?: string }) {
  return (
    <div className="np-row">
      <span className="np-row__label">Who can see it</span>
      <div className="np-row__value">
        <Segmented<Visibility>
          label="Who can see it"
          value={value}
          onChange={onChange}
          options={[
            { value: "private", label: "Private" },
            { value: "public", label: "Public" },
          ]}
        />
        <span className="np-row__hint">{hint ? `${VIS_HELP[value]} ${hint}` : VIS_HELP[value]}</span>
      </div>
    </div>
  );
}

function Problem({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="np-error" role="alert">
      <Icon name="cross" size={12} />
      <div className="np-error__body">
        <p>{children}</p>
        {actions && <div className="np-error__acts">{actions}</div>}
      </div>
    </div>
  );
}

function Submit({ busy, label, disabled, why }: { busy: boolean; label: string; disabled?: boolean; why?: string }) {
  return (
    <div className="np-actions">
      <Button type="submit" variant="primary" icon="plus" busy={busy} disabled={disabled} title={disabled ? why : undefined} aria-keyshortcuts="Enter">
        {label}
      </Button>
      <span className="np-actions__key" aria-hidden="true">
        <kbd className="b-kbd">Enter</kbd>
      </span>
      {disabled && why && <span className="np-actions__why">{why}</span>}
    </div>
  );
}

/**
 * Focus the first field when a step opens (or when `when` turns true), with its text selected, so typing
 * replaces the guess and Enter accepts it.
 */
function useFirstField(when = true) {
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !when) return;
    el.focus({ preventScroll: true });
    el.select();
  }, [when]);
  return (el: HTMLInputElement | null) => {
    ref.current = el;
  };
}

/** Errors of a creation, with the next step for each. */
function createProblem(e: RequestError, returnTo: string, onStep: (s: SourceStep) => void): { text: string; actions?: ReactNode } {
  const install = typeof e.data.installUrl === "string" ? e.data.installUrl : null;
  if (e.status === 401) {
    return {
      text: "Your sign-in ended. Sign in again. gitring keeps your choices.",
      actions: (
        <a className="b-btn b-btn--secondary b-btn--sm" href={githubConnectUrl(returnTo)}>
          <GithubMark size={14} /> Sign in with GitHub
        </a>
      ),
    };
  }
  return {
    text: `The project was not created. ${e.message}`,
    actions: install ? (
      <a className="b-btn b-btn--secondary b-btn--sm" href={install} target="_blank" rel="noopener noreferrer">
        Install the GitHub App <Icon name="external" size={12} />
      </a>
    ) : /larger than|too large|20 MB/i.test(e.message) ? (
      <Button size="sm" onClick={() => onStep({ kind: "push" })}>
        Push with git instead
      </Button>
    ) : undefined,
  };
}

/* ───────────── GitHub repository ───────────── */

export function GithubStep({ step, form, setForm, onBack, onStep, returnTo }: StepProps & { step: Extract<SourceStep, { kind: "github" }> }) {
  const { repo, known } = step;
  const uid = useId().replace(/:/g, "");
  const [guess, setGuess] = useState<ProjectGuess | null>(() => cachedGuess(repo));
  const [guessError, setGuessError] = useState<RequestError | null>(null);
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const [createError, setCreateError] = useState<RequestError | null>(null);
  const first = useFirstField();

  useEffect(() => {
    const hit = nonce === 0 ? cachedGuess(repo) : null;
    if (hit) {
      setGuess(hit);
      return;
    }
    const ctl = new AbortController();
    setGuess(null);
    setGuessError(null);
    guessProject(repo, undefined, ctl.signal).then(setGuess, (e) => {
      if (!isAbort(e)) setGuessError(toError(e));
    });
    return () => ctl.abort();
  }, [repo, nonce]);

  const loading = !guess && !guessError;
  const skeleton = useDelayedFlag(loading);
  const runner = guess?.checks.runner ?? "container";
  const canPush = known ? known.canPush : guess ? guess.sync !== "off" : true;
  const isPrivate = guess?.private ?? known?.private ?? false;
  const v = {
    name: form.name ?? guess?.name ?? nameOfRepo(repo),
    branch: form.branch ?? guess?.branch ?? known?.defaultBranch ?? "",
    install: form.install ?? guess?.checks.install ?? "",
    test: form.test ?? guess?.checks.test ?? "",
    sync: form.sync ?? (canPush ? (guess?.sync ?? "pull-request") : "off"),
    visibility: form.visibility ?? (isPrivate ? "private" : "public"),
  };
  const reasons = guess?.reasons ?? [];
  const hints = {
    branch: reasonFor(reasons, "branch"),
    install: reasonFor(reasons, "install"),
    test: reasonFor(reasons, "test"),
    sync: reasonFor(reasons, "sync"),
  };
  const used = new Set(Object.values(hints).filter(Boolean));
  const rest = reasons.filter((r) => !used.has(r));
  const badBranch = tried && v.branch.trim() !== "" && !validBranch(v.branch.trim());

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (!guess || busy) return;
    const branch = v.branch.trim();
    if (branch && !validBranch(branch)) return;
    setBusy(true);
    setCreateError(null);
    try {
      const install = v.install.trim();
      const test = v.test.trim();
      const project = await createProjectFrom({
        name: v.name.trim() || guess.name || nameOfRepo(repo),
        visibility: v.visibility,
        source: { kind: "github", repo, ...(branch ? { branch } : {}) },
        settings: {
          checks: runner === "container" ? { runner: "container", ...(install ? { install } : {}), ...(test ? { test } : {}) } : { runner: "worker" },
          github: { repo, mode: v.sync, branch: "gitring" },
        },
      });
      openProject(project.id);
    } catch (err) {
      setCreateError(toError(err));
      setBusy(false);
    }
  };

  const title = (
    <>
      <GithubMark size={14} />
      <span className="voice-agent np-step__repo">{repo}</span>
      {isPrivate && (
        <span className="np-tag">
          <LockIcon size={11} /> private
        </span>
      )}
    </>
  );

  if (guessError) {
    const s = guessError.status;
    const install = typeof guessError.data.installUrl === "string" ? guessError.data.installUrl : null;
    const text =
      s === 404
        ? "gitring cannot read this repository. It is private, or the name is wrong."
        : s === 401
          ? "Your sign-in ended. Sign in again. gitring keeps your choice."
          : `gitring could not read the repository. ${guessError.message}`;
    return (
      <div className="np-step">
        <StepHead title={title} onBack={onBack} />
        <Problem
          actions={
            <>
              {s === 401 ? (
                <a className="b-btn b-btn--secondary b-btn--sm" href={githubConnectUrl(returnTo)}>
                  <GithubMark size={14} /> Sign in with GitHub
                </a>
              ) : (
                <Button size="sm" icon="reload" onClick={() => setNonce((n) => n + 1)}>
                  Try again
                </Button>
              )}
              {install && (
                <a className="b-btn b-btn--secondary b-btn--sm" href={install} target="_blank" rel="noopener noreferrer">
                  Install the GitHub App <Icon name="external" size={12} />
                </a>
              )}
              {(s === 404 || s === 403) && (
                <Button size="sm" onClick={() => onStep({ kind: "git", url: `https://github.com/${repo}`, note: "gitring imports the repository by its public URL." })}>
                  Import it by its URL
                </Button>
              )}
              {(s === 404 || s === 403) && (
                <Button size="sm" onClick={() => onStep({ kind: "push" })}>
                  Push with git
                </Button>
              )}
            </>
          }
        >
          {text}
        </Problem>
      </div>
    );
  }

  const problem = createError ? createProblem(createError, returnTo, onStep) : null;
  return (
    <form className="np-step" onSubmit={submit} noValidate aria-busy={loading || undefined}>
      <StepHead title={title} onBack={onBack} />
      <div className="np-rows">
        <Row id={`${uid}-name`} label="Name">
          <Quiet id={`${uid}-name`} value={v.name} onChange={(name) => setForm({ name })} maxLength={80} inputRef={first} />
        </Row>
        {loading ? (
          skeleton ? (
            <div className="np-rows__skel" aria-hidden="true">
              {[64, 48, 56, 72].map((w, i) => (
                <div key={i} className="np-row">
                  <span className="np-skel np-skel--label" />
                  <span className="np-skel" style={{ width: `${w}%` }} />
                </div>
              ))}
            </div>
          ) : (
            <div className="np-rows__wait" />
          )
        ) : (
          <>
            <Row id={`${uid}-branch`} label="Branch" hint={badBranch ? "Use letters, digits, dots, dashes and slashes." : hints.branch}>
              <Quiet id={`${uid}-branch`} value={v.branch} onChange={(branch) => setForm({ branch })} mono hint={Boolean(badBranch || hints.branch)} invalid={badBranch} placeholder="main" />
            </Row>
            {runner === "container" ? (
              <>
                <Row id={`${uid}-install`} label="Install" hint={hints.install ?? (v.install ? undefined : "Empty: npm ci with a package-lock.json, else npm install.")}>
                  <Quiet id={`${uid}-install`} value={v.install} onChange={(install) => setForm({ install })} mono hint placeholder="npm ci" />
                </Row>
                <Row id={`${uid}-test`} label="Test" hint={hints.test ?? (v.test ? undefined : "Empty: npm test.")}>
                  <Quiet id={`${uid}-test`} value={v.test} onChange={(test) => setForm({ test })} mono hint placeholder="npm test" />
                </Row>
              </>
            ) : (
              <div className="np-row">
                <span className="np-row__label">Tests</span>
                <div className="np-row__value">
                  <span className="np-row__text">The gitring test runner runs tests/*.test.js.</span>
                  {hints.test && <span className="np-row__hint">{hints.test}</span>}
                </div>
              </div>
            )}
            <div className="np-row">
              <span className="np-row__label">Merged code</span>
              <div className="np-row__value">
                {canPush ? (
                  <Segmented<GithubSyncMode>
                    label="Where merged code goes"
                    value={v.sync}
                    onChange={(sync) => setForm({ sync })}
                    options={[
                      { value: "off", label: "Off" },
                      { value: "pull-request", label: "Pull request" },
                      { value: "main", label: "Straight to main" },
                    ]}
                  />
                ) : (
                  <span className="np-row__text">Stays in gitring.</span>
                )}
                <span className="np-row__hint">{canPush ? (hints.sync ?? SYNC_TEXT[v.sync]) : "You cannot push to this repository, so gitring does not send code to GitHub."}</span>
              </div>
            </div>
            <VisibilityRow value={v.visibility} onChange={(visibility) => setForm({ visibility })} hint={form.visibility === undefined ? "Same as the repository." : undefined} />
            {rest.length > 0 && (
              <ul className="np-reasons" aria-label="How gitring guessed">
                {rest.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
      {problem && <Problem actions={problem.actions}>{problem.text}</Problem>}
      <Submit busy={busy} label={busy ? "Creating the project…" : "Create project"} disabled={loading} why={loading ? "gitring reads the repository." : undefined} />
    </form>
  );
}

/* ───────────── public git URL ───────────── */

export function UrlStep({ step, form, setForm, onBack, onStep, returnTo }: StepProps & { step: Extract<SourceStep, { kind: "git" }> }) {
  const uid = useId().replace(/:/g, "");
  const url = form.url ?? step.url;
  const read = readPasted(url);
  const okUrl = read?.kind === "git" ? read.url : read?.kind === "github" ? read.url : null;
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<RequestError | null>(null);
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
          <Quiet id={`${uid}-url`} value={url} onChange={(u) => setForm({ url: u })} mono hint invalid={badUrl} inputMode="url" placeholder="https://github.com/owner/repo" />
        </Row>
        <Row id={`${uid}-name`} label="Name">
          <Quiet id={`${uid}-name`} value={v.name} onChange={(name) => setForm({ name })} maxLength={80} inputRef={first} />
        </Row>
        <Row id={`${uid}-branch`} label="Branch" hint={badBranch ? "Use letters, digits, dots, dashes and slashes." : "Empty: the default branch."}>
          <Quiet id={`${uid}-branch`} value={v.branch} onChange={(branch) => setForm({ branch })} mono hint invalid={badBranch} placeholder="default branch" />
        </Row>
        <VisibilityRow value={v.visibility} onChange={(visibility) => setForm({ visibility })} hint={form.visibility === undefined ? "Same as the repository." : undefined} />
      </div>
      {problem && <Problem actions={problem.actions}>{problem.text}</Problem>}
      <p className="np-step__note">Cloudflare Artifacts imports the repository with its history. A large repository takes some minutes.</p>
      <Submit busy={busy} label={busy ? "Creating the project…" : "Create project"} />
    </form>
  );
}

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
          <Button ref={choose} icon="launch" onClick={onChooseFolder}>
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
        label={busy === "read" ? `Reading ${plan?.keep.length ?? 0} files…` : busy === "create" ? "Creating the project…" : "Create project"}
        disabled={!plan || tooBig || none}
        why={!plan ? "Choose a folder first." : undefined}
      />
    </form>
  );
}

/* ───────────── git push and empty ───────────── */

const PLAIN: Record<"push" | "empty", { title: string; text: string; source: ProjectSource }> = {
  push: {
    title: "Push with git",
    text: "gitring makes an empty repository. Then you push your repository to it with git: private repositories from any host, with their history. The overview shows the command.",
    source: { kind: "push" },
  },
  empty: {
    title: "Empty project",
    text: "gitring makes a repository with a README. Write a task, and agents write the first files.",
    source: { kind: "empty" },
  },
};

export function PlainStep({ kind, form, setForm, onBack, onStep, returnTo }: StepProps & { kind: "push" | "empty" }) {
  const uid = useId().replace(/:/g, "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<RequestError | null>(null);
  const first = useFirstField();
  const d = PLAIN[kind];
  const v = { name: form.name ?? "New project", visibility: form.visibility ?? ("private" as Visibility) };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const project = await createProjectFrom({ name: v.name.trim() || "New project", visibility: v.visibility, source: d.source });
      openProject(project.id);
    } catch (err) {
      setError(toError(err));
      setBusy(false);
    }
  };

  const problem = error ? createProblem(error, returnTo, onStep) : null;
  return (
    <form className="np-step" onSubmit={submit} noValidate>
      <StepHead title={d.title} onBack={onBack} />
      <p className="np-step__note">{d.text}</p>
      <div className="np-rows">
        <Row id={`${uid}-name`} label="Name">
          <Quiet id={`${uid}-name`} value={v.name} onChange={(name) => setForm({ name })} maxLength={80} inputRef={first} placeholder="New project" />
        </Row>
        <VisibilityRow value={v.visibility} onChange={(visibility) => setForm({ visibility })} />
      </div>
      {problem && <Problem actions={problem.actions}>{problem.text}</Problem>}
      <Submit busy={busy} label={busy ? "Creating the project…" : "Create project"} />
    </form>
  );
}
