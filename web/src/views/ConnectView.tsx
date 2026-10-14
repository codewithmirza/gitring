/**
 * "/connect": add gitring to an agent. Ask "Which agent do you use?" and show one command or one URL.
 *
 * Every other way (API key, git mode, hook, inputs, events, GitHub) is folded under "More ways".
 * Requests: the connect info once for each project; the OAuth apps every 5 s only while this tab is visible
 * and no app is connected yet (agents that work on the project arrive over the live socket).
 * Read next: connect/ (the agent choice, the live line, the folded ways) and connect-text.ts (the words).
 */
import { useEffect, useState } from "react";
import { Icon } from "../design/icons";
import { harborOrNull, onHarbor, defaultConnectInfo, type ConnectInfo } from "../state/api";
import { useStore } from "../state/store";
import { ConnectorSection } from "./connect/ConnectorSection";
import { MoreWays } from "./connect/MoreWays";
import "./connect.css";
import "./projects.css";

export function ConnectView() {
  const projectId = useStore((s) => s.projectId);
  const branch = useStore((s) => s.state?.project.repo.defaultBranch ?? "main");
  const githubOn = useStore((s) => (s.state?.project.settings.github?.mode ?? "off") !== "off");
  const [info, setInfo] = useState<ConnectInfo>(() => defaultConnectInfo(projectId));

  useEffect(() => {
    setInfo(defaultConnectInfo(projectId));
    const load = () => {
      harborOrNull()
        ?.connect()
        // Fill fields that an older server does not send, so that the page never breaks on them.
        .then((i) => setInfo({ ...defaultConnectInfo(projectId), ...i, inputs: { ...defaultConnectInfo(projectId).inputs, ...(i?.inputs ?? {}) } }))
        .catch(() => undefined);
    };
    load();
    return onHarbor(load);
  }, [projectId]);

  return (
    <div className="page connect">
      <p className="page__eyebrow">
        <Icon name="plug" size={14} /> Connect
      </p>
      <h1 className="page__title" tabIndex={-1}>
        Connect an agent
      </h1>
      <p className="page__lede">Choose your agent and copy one line. Then it works on this project, and gitring merges its work when the tests pass.</p>

      <ConnectorSection mcpUrl={info.mcpUrl} />

      <MoreWays info={info} project={info.projectId || projectId} branch={branch} githubOn={githubOn} />
    </div>
  );
}
