/**
 * The step for a GitHub repository: gitring guesses the name and branch; the person can change the sync mode.
 * GitHub is optional. Sync is off by default.
 */
import { useEffect, useId, useState, type FormEvent } from "react";
import type { ProjectGuess } from "../../../../../src/core/accounts";
import type { GithubSyncMode } from "../../../../../src/core/types";
import { Button, Segmented } from "../../../design/components";
import { Icon } from "../../../design/icons";
import { openProject } from "../../../state/account";
import { openSignIn } from "../../../app/ui";
import { cachedGuess, guessProject, isAbort, RequestError, useDelayedFlag } from "../../../state/github";
import { createProjectFrom } from "../../../state/projects";
import type { SourceStep } from "../draft";
import { GithubMark, LockIcon } from "../marks";
import { nameOfRepo, reasonFor, validBranch } from "../match";
import { createProblem, Problem, Quiet, Row, StepHead, type StepProps, Submit, SYNC_TEXT, toError, useFirstField, VisibilityRow } from "./shared";

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
  // The guess knows best: GitHub sync needs the app on the repository and a person who can push.
  const canSync = guess ? Boolean(guess.canSync ?? guess.sync !== "off") : (known?.canPush ?? false);
  const isPrivate = guess?.private ?? known?.private ?? false;
  const v = {
    name: form.name ?? guess?.name ?? nameOfRepo(repo),
    branch: form.branch ?? guess?.branch ?? known?.defaultBranch ?? "",
    install: form.install ?? guess?.checks.install ?? "",
    test: form.test ?? guess?.checks.test ?? "",
    // GitHub is optional: sync starts off, and the person turns it on here or later in Settings.
    sync: form.sync ?? (canSync ? (guess?.sync ?? "off") : "off"),
    visibility: form.visibility ?? (isPrivate ? "private" : "public"),
  };
  const reasons = guess?.reasons ?? [];
  // A model answer (rules found zero or several commands) starts with "Guess:" and gets the tag "guess".
  const modelGuess = reasons.find((r) => /^guess\b/i.test(r));
  const plain = reasons.filter((r) => r !== modelGuess);
  const hints = {
    branch: reasonFor(plain, "branch"),
    install: reasonFor(plain, "install"),
    test: modelGuess ?? reasonFor(plain, "test"),
    sync: reasonFor(plain, "sync"),
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
      // GitHub's own spelling of the name (the guess has it).
      const full = guess.repo || repo;
      const project = await createProjectFrom({
        name: v.name.trim() || guess.name || nameOfRepo(full),
        visibility: v.visibility,
        source: { kind: "github", repo: full, ...(branch ? { branch } : {}) },
        settings: {
          checks: runner === "container" ? { runner: "container", ...(install ? { install } : {}), ...(test ? { test } : {}) } : { runner: "worker" },
          github: { repo: full, mode: v.sync, branch: "gitring" },
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
    // The server writes its own plain sentence; a bare status gets ours.
    const own = guessError.message && !/^(gitring did not find it|Sign in first|The request failed)/.test(guessError.message);
    const text =
      s === 401
        ? "Your sign-in ended. Sign in again. gitring keeps your choice."
        : own
          ? guessError.message
          : s === 404
            ? "gitring cannot read this repository. It is private, or the name is wrong."
            : `gitring could not read the repository. ${guessError.message}`;
    return (
      <div className="np-step">
        <StepHead title={title} onBack={onBack} />
        <Problem
          actions={
            <>
              {s === 401 ? (
                // The gitring sign-in ended: any sign-in choice works, and the link of the step comes back here.
                <Button size="sm" onClick={(ev) => openSignIn({ anchor: ev.currentTarget, reason: "Sign in again to import the repository.", then: { kind: "go", to: returnTo } })}>
                  Sign in again
                </Button>
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
                <Row
                  id={`${uid}-install`}
                  label="Install"
                  tag={modelGuess && form.install === undefined ? "guess" : undefined}
                  hint={hints.install ?? (v.install ? undefined : "Empty: npm ci with a package-lock.json, else npm install.")}
                >
                  <Quiet id={`${uid}-install`} value={v.install} onChange={(install) => setForm({ install })} mono hint placeholder="npm ci" />
                </Row>
                <Row id={`${uid}-test`} label="Test" tag={modelGuess && form.test === undefined ? "guess" : undefined} hint={hints.test ?? (v.test ? undefined : "Empty: npm test.")}>
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
                {canSync ? (
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
                {/* With a choice, the hint follows the choice; without one, the guess says why. */}
                <span className="np-row__hint">{canSync ? SYNC_TEXT[v.sync] : (hints.sync ?? "You cannot push to this repository, so gitring does not send code to GitHub.")}</span>
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
      <Submit busy={busy} label={busy ? "Please wait…" : "Create project"} disabled={loading} why={loading ? "gitring reads the repository." : undefined} />
    </form>
  );
}
