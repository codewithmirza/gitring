/**
 * The panel that the overview shows while main is empty.
 * It covers four cases: a new project that waits for its first task, an import in progress, an import error, and a push
 * project that waits for its first `git push` (with the command and a one-day token for the owner).
 * The live socket fills the overview when main changes. "Check now" asks the server at once.
 */
import { useState } from "react";
import { Button, CodeBlock, toast } from "../design/components";
import { Icon } from "../design/icons";
import { checkImport, pushToken, useCanAct, useIsOwner } from "../state/account";
import { useStore } from "../state/store";
import { navigate } from "./router";
import { openNewIntent } from "./ui";
import "../views/newproject/importpanel.css";

export function ImportPanel() {
  const projectId = useStore((s) => s.projectId);
  const importing = useStore((s) => s.state?.project.importing ?? null);
  const source = useStore((s) => s.state?.project.source);
  const owner = useIsOwner();
  const canAct = useCanAct();
  const [push, setPush] = useState<{ remote: string; token: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState<"token" | "check" | null>(null);

  const check = async (quiet = false) => {
    setBusy("check");
    try {
      const r = await checkImport(projectId);
      if (r.importing && !quiet) {
        toast({ tone: "info", title: r.importing.error ? "The import did not finish" : "Not done yet", text: r.importing.error ?? "gitring looks again by itself. The overview fills when main is ready." });
      }
    } catch (e) {
      toast({ tone: "danger", title: "gitring could not look now", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  if (!importing) {
    return (
      <div className="importpanel">
        <h2 className="importpanel__title">Main has no files yet</h2>
        <p className="importpanel__text">Write a task. Agents read its title and goal, and they write the first files.</p>
        {canAct && (
          <Button variant="primary" icon="plus" onClick={openNewIntent} aria-keyshortcuts="n">
            Write the first task
          </Button>
        )}
      </div>
    );
  }

  const from = source?.kind === "github" ? `${source.repo} from GitHub` : importing.url.replace(/^https:\/\//, "");

  if (importing.error) {
    return (
      <div className="importpanel">
        <h2 className="importpanel__title">The import did not finish</h2>
        <p className="importpanel__error" role="alert">
          <Icon name="cross" size={12} />
          <span>{importing.error}</span>
        </p>
        <p className="importpanel__text">Check again in a moment. If the repository is private and not on GitHub, push it with git into a new project.</p>
        {canAct && (
          <div className="importpanel__acts">
            <Button icon="reload" busy={busy === "check"} onClick={() => void check()}>
              Check again
            </Button>
            <Button icon="plus" onClick={() => navigate("/projects?new=1")}>
              New project
            </Button>
          </div>
        )}
      </div>
    );
  }

  if (!importing.push) {
    return (
      <div className="importpanel" aria-busy="true">
        <h2 className="importpanel__title">gitring imports {from}</h2>
        <p className="importpanel__text">Cloudflare Artifacts copies the repository with its history. The overview fills when the import is done. A large repository takes some minutes.</p>
        <div className="importpanel__progress" aria-hidden="true" />
        {canAct && (
          <div className="importpanel__acts">
            <Button size="sm" icon="reload" busy={busy === "check"} onClick={() => void check()}>
              Check now
            </Button>
          </div>
        )}
      </div>
    );
  }

  const take = async () => {
    setBusy("token");
    try {
      setPush(await pushToken(projectId));
    } catch (e) {
      toast({ tone: "danger", title: "No push command", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const authed = push ? push.remote.replace(/^https:\/\//, `https://x:${push.token}@`) : "";
  return (
    <div className="importpanel">
      <h2 className="importpanel__title">Push your repository</h2>
      <p className="importpanel__text">
        This project waits for its first <span className="voice-agent">git push</span>. Push from a clone of your repository on GitHub, GitLab or any host, private
        repositories too. gitring takes the branch you push as main.
      </p>
      {owner ? (
        push ? (
          <>
            <CodeBlock shell label="In your repository" code={`git push ${authed} HEAD:main`} copyLabel="Copy command" />
            <p className="importpanel__note">
              The token in this command works until {new Date(push.expiresAt).toLocaleString()} and only for this push. gitring revokes it when the push arrives.
              Keep it private.
            </p>
          </>
        ) : (
          <Button variant="primary" icon="launch" busy={busy === "token"} onClick={() => void take()}>
            Show the push command
          </Button>
        )
      ) : (
        <p className="importpanel__note">The owner of this project pushes the repository.</p>
      )}
      {canAct && (
        <div className="importpanel__acts">
          <Button size="sm" icon="reload" busy={busy === "check"} onClick={() => void check()}>
            I pushed. Check now
          </Button>
        </div>
      )}
    </div>
  );
}
