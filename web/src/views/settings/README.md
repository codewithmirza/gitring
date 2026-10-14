# views/settings

The sections of the settings page. `../SettingsView.tsx` shows the tabs and composes the sections, one at a time.

- `sections.ts`: the list of tabs, the old names of an address (`st-checks`, `repo`) and the hook that reads the shown section.
- `shared.tsx`: the props of a section, `useSave` and the inline error.
- `GeneralSection.tsx`: the name, who can see the project, and the repository (id, main branch, git address).
- `MembersSection.tsx`: who is in the project, with a role each, and the form to add a person.
- `MergingSection.tsx`: who says yes, rules by folder, and work that cannot merge.
- `ChecksSection.tsx`: how and when tests run.
- `GithubSection.tsx`: the linked repository, the sync mode and the sync status.
- `WebhooksSection.tsx`: signed events that gitring sends out.
- `ArchiveSection.tsx`: take the project out of every list (owners only).
