# views/settings

The sections of the settings page. `../SettingsView.tsx` composes them (General and Members are in that file).

- `shared.tsx`: the props of a section, `useSave` and the inline error.
- `MergingSection.tsx`: who says yes, rules by folder, and work that cannot merge.
- `ChecksSection.tsx`: how and when tests run.
- `GithubSection.tsx`: the linked repository, the sync mode and the sync status.
- `WebhooksSection.tsx`: signed events that gitring sends out.
