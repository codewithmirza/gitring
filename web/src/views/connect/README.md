# views/connect

The parts of the connect page. `../ConnectView.tsx` composes them. The words of the page are in `../connect-text.ts`.

- `FlowDiagram.tsx`: the diagram of what goes into gitring and what comes out.
- `shared.tsx`: parts that the other files share (a narrow-screen hook, a remembered choice, a section, a copy field).
- `clients.ts`: the agent apps that the page names, and the Cursor install link.
- `ConnectorSection.tsx`: add gitring to an agent app by OAuth, with the live status.
- `KeySection.tsx`: make a personal API key and show the setup text.
