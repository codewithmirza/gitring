/**
 * Shown on the chart while main is empty: an import in progress, an import error, or a push project
 * that waits for its first `git push` (with the commands and a one-day token for the owner).
 */
import { useState } from "react";
import { Button, CodeBlock, EmptyState, toast } from "../design/components";
import { checkImport, pushToken, useIsOwner } from "../state/account";
import { useStore } from "../state/store";

export function ImportPanel() {
  const projectId = useStore((s) => s.projectId);
  const importing = useStore((s) => s.state?.project.importing ?? null);
  const owner = useIsOwner();
  const [push, setPush] = useState<{ remote: string; token: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState<"token" | "check" | null>(null);

  if (!importing) return <EmptyState art={false} text="Main has no text files yet. Open an intent and let agents write the first files." />;
  if (importing.error) return <EmptyState art={false} text={`The import failed. ${importing.error}`} />;
  if (!importing.push) {
    return (
      <EmptyState
        art={false}
        text={`Cloudflare Artifacts imports ${importing.url.replace(/^https:\/\//, "")}. The chart fills when the import is done. A large repository takes some minutes.`}
      />
    );
  }

  const take = async () => {
    setBusy("token");
    try {
      setPush(await pushToken(projectId));
    } catch (e) {
      toast({ tone: "danger", title: "No push token", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const check = async () => {
    setBusy("check");
    try {
      const r = await checkImport(projectId);
      if (r.importing) toast({ tone: "info", title: "No push yet", text: "Gitring looks again every few minutes." });
    } catch (e) {
      toast({ tone: "danger", title: "The check failed", text: (e as Error).message });
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
        repositories too. Gitring adopts the branch you push as main.
      </p>
      {owner ? (
        push ? (
          <>
            <CodeBlock shell label="In your repository" code={`git push ${authed} HEAD:main`} copyLabel="Copy command" />
            <p className="importpanel__note">
              The token in this command works until {new Date(push.expiresAt).toLocaleString()} and only for this push. Gitring revokes it when the push arrives.
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
      <Button size="sm" icon="reload" busy={busy === "check"} onClick={() => void check()}>
        I pushed. Check now
      </Button>
    </div>
  );
}
