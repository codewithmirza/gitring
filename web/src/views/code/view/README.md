# code/view

The parts of the code page. `../../CodeView.tsx` puts them together: it calls `useCodeView()` and draws the toolbar, the tree pane, the file pane and the mark popover.

How it works: `model.ts` calls the hooks in order and returns one model. Each hook owns one concern and reads the results of the hooks before it. Each pane reads what it needs from the model.

The hooks, in call order:

- `useCodeSource.ts`: the address, the project data from the store, the ref on screen, its tree and its diff.
- `useFileTree.ts`: the rows of the tree, the open folders, the filter and the marks on rows.
- `useOpenFile.ts`: the text of the open file, the README, the gutter marks and the loading flags.
- `useCodeCursor.ts`: the selected lines, jumps to a line and the move between marks.
- `useCodePanels.ts`: popovers, soft wrap, the tree on or off, the phone panel and the copy notice.
- `useCodeNavigation.tsx`: open a path, links, prefetch, the list of refs and the finder marks.
- `useCodeActions.ts`: the keys, the links to copy or open elsewhere, and the tab title.
- `describeRef.tsx`: the label and the plain words of the ref on screen (a plain function).
- `renderMain.tsx`: what the right side shows (a plain function).
- `whyLine.ts`: the line that "Why?" asks about, and the scroll of a line into the strip above the phone sheet.

The panes and parts:

- `CodeToolbar.tsx`, `TreePane.tsx`, `FilePane.tsx`: the three regions of the screen.
- `ContextStrip.tsx`: who works on this file.
- `MarkCard.tsx`: the card under a line mark.
- `RefOverview.tsx`: what a ref shows when no file is open.
- `Skeletons.tsx`: the loading shapes.
- `Dot.tsx`: the colored dot of an agent.
- `browser.ts`: local storage flags, the narrow-screen hook and copy to the clipboard.
- `empty.ts`: shared empty values for the store selectors.
