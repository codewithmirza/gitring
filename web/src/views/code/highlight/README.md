# code/highlight

The syntax highlighter of the code view, one file for each language. Import from `../highlight` (the front door), not from this folder.

- `classes.ts`: the token classes (a number for each kind of text) and their CSS class names.
- `language.ts`: the language of a file name, and of a Markdown fence label.
- `emit.ts`: `Emit` collects the tokens of a line; `make` builds a `Highlighter` from a line function.
- `scanners.ts`: character tests, sticky regexes and quoted strings that every language uses.
- `javascript.ts`: JavaScript, TypeScript and JSX (one state machine).
- `json.ts`: JSON.
- `css.ts`: CSS.
- `html.ts`: HTML and XML, with JavaScript in script blocks and CSS in style blocks.
- `python.ts`: Python.
- `go.ts`: Go.
- `registry.ts`: `highlighterFor` picks the highlighter of a language; the Markdown scanner lives here too.
- `lines.ts`: `tokenizeAll`, `runsOf` and `LineHighlighter` run a highlighter over many lines.
