import { useId } from "react";
import { Badge } from "../design/components";
import type { Choice } from "./approval-copy";

interface ChoiceListProps<T extends string> {
  legend: string;
  choices: Choice<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Read only: the radios are disabled and show the value. */
  disabled?: boolean;
}

/**
 * A radio group where each choice has a help text under its name. The radios are native: Tab reaches the
 * checked one, and the arrow keys move and select. A Segmented control cannot hold a help text under each
 * choice, and three long names do not fit in one row on a phone.
 *
 * Each choice is one label around the radio, the name and the help: the whole card is the click target, and
 * nothing covers the radio. The name of the radio is the name text only; the help is its description.
 */
export function ChoiceList<T extends string>({ legend, choices, value, onChange, disabled }: ChoiceListProps<T>) {
  const uid = useId().replace(/:/g, "");
  return (
    <fieldset className="st-choice" role="radiogroup" aria-labelledby={`${uid}-legend`} disabled={disabled}>
      <legend className="b-field__label st-choice__legend" id={`${uid}-legend`}>
        {legend}
      </legend>
      {choices.map((c) => {
        const id = `${uid}-${c.value}`;
        return (
          <label key={c.value} className="st-choice__opt">
            <input type="radio" name={uid} value={c.value} checked={c.value === value} onChange={() => onChange(c.value)} aria-labelledby={`${id}-name`} aria-describedby={`${id}-help`} />
            <span className="st-choice__name" id={`${id}-name`}>
              {c.label}
              {c.badge && (
                <>
                  {" "}
                  <Badge tone="accent" className="st-choice__badge">
                    {c.badge}
                  </Badge>
                </>
              )}
            </span>
            <span className="st-choice__help" id={`${id}-help`}>
              {c.help}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}
