/** One GitHub repository in a list: lock or book, owner/name, tags, branch, language, last push, description. */
import type { GithubRepo } from "../../../../src/core/accounts";
import { LockIcon, RepoIcon } from "./marks";
import { agoIso } from "./match";

export function RepoRow({ repo }: { repo: GithubRepo }) {
  const slash = repo.fullName.indexOf("/");
  return (
    <>
      {repo.private ? <LockIcon className="np-opt__icon" /> : <RepoIcon className="np-opt__icon" />}
      <span className="np-opt__main">
        <span className="np-opt__title">
          <span className="voice-agent np-repo">
            <span className="np-repo__owner">{repo.fullName.slice(0, slash + 1)}</span>
            {repo.fullName.slice(slash + 1)}
          </span>
          {repo.private && <span className="np-tag">private</span>}
          {!repo.canPush && <span className="np-tag">read only</span>}
        </span>
        <span className="np-opt__text">
          {[repo.defaultBranch, repo.language, repo.pushedAt && `pushed ${agoIso(repo.pushedAt)}`].filter(Boolean).map((fact) => (
            <span key={String(fact)} className="np-opt__fact">
              {fact}
            </span>
          ))}
          {repo.description ? <span className="np-opt__desc">{repo.description}</span> : null}
        </span>
      </span>
    </>
  );
}
