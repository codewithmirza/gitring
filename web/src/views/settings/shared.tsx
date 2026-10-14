/**
 * What every settings section shares: its props, the hook that saves a part, the inline error.
 * A section saves only its own part. The server merges it and answers the full settings.
 */
import { useState } from "react";
import { toast } from "../../design/components";
import { Icon } from "../../design/icons";
import type { ProjectSettings } from "../../../../src/core/types";
import { putSettings } from "../../state/account";

/** Save a part of the settings. The server merges it and answers the full settings (or an error to show inline). */
export function useSave(projectId: string, onSaved: (s: ProjectSettings) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (patch: Partial<ProjectSettings>, done: string): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await putSettings(projectId, patch));
      toast({ tone: "info", title: done });
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, save };
}

export function SaveError({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p className="st-error" role="alert">
      <Icon name="cross" size={12} /> {error}
    </p>
  );
}

export interface SectionProps {
  projectId: string;
  owner: boolean;
  settings: ProjectSettings;
  onSaved: (s: ProjectSettings) => void;
}
