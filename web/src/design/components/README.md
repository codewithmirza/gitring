# design/components

The components of the design system. Import from `./index.ts` (the public surface), not from single files.

- `index.ts`: re-exports every public component and loads the styles.
- `components.css`: the styles; it imports `styles/` in order. `styles/` is described in its README.
- `Button.tsx`: Button and IconButton.
- `Segmented.tsx`: a segmented control (radio group).
- `Field.tsx`: Field (label, help, error), Input, Textarea, Select and Checkbox.
- `Badge.tsx`: badges for status and merge methods.
- `Callsign.tsx`: the name of an agent with its pennant and shape.
- `Panel.tsx`: a panel with a header row, and the section label.
- `EvidenceBar.tsx`: one segment for each test.
- `DiffView.tsx`: a unified diff as rows.
- `LineRequest.tsx`: pick lines in a diff and ask the agent to change them.
- `PreviewFrame.tsx`: the real running work copy in a sandboxed iframe.
- `CorrectionNotice.tsx`: one change request with its status.
- `CourseCheckReadout.tsx`: the numbers of a conflict check against their limits.
- `RangeIndicator.tsx`: the distance of two plans.
- `LogLine.tsx`: one row of the activity log.
- `Stat.tsx`: a number with a label.
- `Toast.tsx`: toasts at the bottom right.
- `Dialog.tsx`: a dialog or a side sheet on the native dialog element.
- `Tabs.tsx`: tabs and their panels.
- `Tooltip.tsx`: a tooltip on hover and focus.
- `Kbd.tsx`: a keyboard hint.
- `CodeBlock.tsx`: monospace text with a copy button.
- `EmptyState.tsx`: an empty state with a drawing, a sentence and an action.
- `Popover.tsx`: the anchored popover and the focus helpers.
- `placement.ts`: where an anchored popover goes (a pure function).
- `Menu.tsx`: a menu of actions on a popover.
- `InlineConfirm.tsx`: a button that asks for a second click in place.
- `InlinePanel.tsx`: a short form that opens in place.
- `Skeleton.tsx`: grey loading shapes.
- `ProgressRule.tsx`: a hairline progress rule.
