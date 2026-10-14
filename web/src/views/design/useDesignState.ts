/**
 * The small state of the style guide: sample segment, tab, dialog and the icon names.
 */
import { useState } from "react";
import { ICONS, type IconName } from "../../design/icons";

export function useDesignState() {
  const [seg, setSeg] = useState<"chart" | "intents" | "logbook">("chart");
  const [tab, setTab] = useState<"a" | "b" | "c">("a");
  const [dialog, setDialog] = useState(false);
  const iconNames = Object.keys(ICONS) as IconName[];

  return { seg, setSeg, tab, setTab, dialog, setDialog, iconNames };
}

export type DesignState = ReturnType<typeof useDesignState>;
