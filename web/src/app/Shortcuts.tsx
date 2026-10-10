/** The keyboard shortcut list: a popover from "Shortcuts" in the top bar (or from Search when that is hidden). */
import { useMemo } from "react";
import { Kbd, Popover } from "../design/components";
import { setUi, useUi } from "./ui";
import { PALETTE_KEY } from "./keys";
import { visibleAnchor } from "./Account";

const GROUPS: { title: string; rows: [string[], string][] }[] = [
  {
    title: "Go to",
    rows: [
      [["g", "o"], "Overview"],
      [["g", "t"], "Tasks"],
      [["g", "h"], "History"],
      [["g", "c"], "Code"],
      [["g", "k"], "Connect"],
      [["g", "p"], "Projects"],
      [["g", "a"], "Account"],
      ...(import.meta.env.DEV ? ([[["g", "d"], "Design (development only)"]] as [string[], string][]) : []),
    ],
  },
  {
    title: "Do",
    rows: [
      [[PALETTE_KEY], "Search and commands"],
      [["/"], "Search"],
      [["n"], "Write a task"],
      [["?"], "Show these shortcuts"],
    ],
  },
  {
    title: "In lists and panels",
    rows: [
      [["j", "k"], "Next and previous decision"],
      [["Enter"], "Run the selected action"],
      [["Esc"], "Close a panel. Typed text stays."],
    ],
  },
  {
    title: "On the overview map",
    rows: [
      [["←", "↑", "→", "↓"], "Move the map (Shift: move more)"],
      [["+", "−"], "Zoom in or out"],
      [["0"], "Fit the map"],
    ],
  },
];

export function ShortcutsPopover() {
  const { shortcuts, shortcutsAnchor } = useUi();
  const anchor = useMemo(() => (shortcuts ? visibleAnchor(shortcutsAnchor, "[data-shortcuts-anchor], [data-palette-anchor]") : null), [shortcuts, shortcutsAnchor]);
  const close = () => setUi({ shortcuts: false, shortcutsAnchor: null });
  if (!shortcuts || !anchor) return null;
  return (
    <Popover anchor={anchor} open onClose={close} labelledBy="shortcuts-title" align="end" width={420}>
      <div className="shortcuts">
        <h2 className="pop-title" id="shortcuts-title">
          Keyboard shortcuts
        </h2>
        <p className="pop-help">Shortcuts work when the focus is not in a text field. Tab moves through lists and agents.</p>
        {GROUPS.map((g) => (
          <section key={g.title} className="shortcuts__group" aria-label={g.title}>
            <h3 className="shortcuts__h">{g.title}</h3>
            <dl className="shortcuts__list">
              {g.rows.map(([keys, text]) => (
                <div key={text} className="shortcuts__row">
                  <dt>
                    {keys.map((k) => (
                      <Kbd key={k}>{k}</Kbd>
                    ))}
                  </dt>
                  <dd>{text}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Popover>
  );
}
