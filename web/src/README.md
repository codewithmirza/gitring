# web/src

The web app of gitring: a React app that talks to the Worker over REST and over one WebSocket for each project. Start here, then open the README of the folder you need.

- `main.tsx`: the entry. It loads the styles, starts the theme and the boot, and draws `App`.
- `app/`: the shell around every page: the top bar, the router, the rails, the palette and the parts that more than one page uses.
- `views/`: one file for each page of the app, with a folder for the parts of each big page.
- `chart/`: the overview map: the repository as islands, with every active agent on it.
- `state/`: what the app knows and how it asks the Worker: the store, the requests and the derived views.
- `design/`: the design system: tokens, base styles, icons, fonts, the theme and the components.

Things to know before you move code:

- The shell loads the pages of `views/` lazily, each in its own chunk, through `app/views.ts`. Only the start page and the waitlist pages load with the shell. Never import another page from the shell.
- A page file (for example `views/CodeView.tsx`) is the front door of its folder. Other files load it by its path, so keep the file name and its exports.
- Shared types come from `../../src/core`, outside the web app.
- The order of the rules in a CSS file is part of the look. A big style file only lists the files of its `styles/` folder in order.
