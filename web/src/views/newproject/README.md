# views/newproject

The new-project picker: where a person starts a project. `../ProjectsView.tsx` opens it from a button.

- `NewProject.tsx`: the panel: a description on top, then the sources, then the step of the chosen source.
- `StartList.tsx`: the first view: the describe field and the list of sources.
- `SourceList.tsx`: the person's GitHub repositories (the last group of the picker).
- `RepoSelect.tsx`: a repository field with a list (a combobox).
- `RepoRow.tsx`: one repository in a list.
- `steps.tsx`: the second step (front door of `steps/`).
- `steps/`: one file for each source (see its README).
- `draft.ts`: the draft of a new project and the links that open the picker at one source.
- `match.ts`: pure helpers: rank repositories, read a pasted URL, suggest names.
- `start-text.ts`: the words of the first view.
- `AnchoredPanel.tsx`: a panel that grows from its button, with a tail.
- `marks.tsx`: the icons of the flow.
- `newproject.css`: the styles of the picker.
- `importpanel.css`: the styles of the panel that the overview shows while main is empty.
