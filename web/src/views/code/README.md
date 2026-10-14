# views/code

The parts of the code page. `../CodeView.tsx` puts the page together; the state and the panes are in `view/`.

- `data.ts`: loads the files of a ref and the text of one file.
- `links.ts`: the addresses of the code page and how to read them.
- `tree.ts`: the file tree without the DOM (build, flatten, filter, find a file).
- `annotations.ts`: the marks of agents and change requests, from the live state.
- `history.ts`: the addresses and words of "Why is this line here?" and the history of a file.
- `CodeTree.tsx`: the file tree as a virtual list.
- `CodeLines.tsx`: the lines of one file with the gutter marks and the syntax colors.
- `CodeDiff.tsx`: a work copy against its base, as a diff.
- `CodeLink.tsx`: a link that changes the view without a page load.
- `LineHistory.tsx`: the "Why line N?" and "History" actions.
- `CloneButton.tsx`: "Clone", a git clone command with a read token.
- `pickers.tsx`: the ref switcher, the file finder, "go to line" and the more menu.
- `highlight.ts`: the syntax highlighter (front door of `highlight/`).
- `highlight/`: one file for each language (see its README).
- `view/`: the state hooks and the panes of the page (see its README).
- `code.css`: the styles of the page; it imports `styles/` in order.
- `history.css`: the styles of the history panels.
- `styles/`: the parts of `code.css` (see its README).
