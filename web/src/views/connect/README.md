# views/connect

The parts of the connect page. `../ConnectView.tsx` composes them. The words of the page are in `../connect-text.ts`.

- `ConnectorSection.tsx`: "Which agent do you use?", then one command or one URL for that agent.
- `LiveStatus.tsx`: the line under the choice: "gitring waits for your agent", then the connected apps.
- `MoreWays.tsx`: every other way (git mode, hook, inputs, events, GitHub, other addresses, the flow), folded and closed at first.
- `KeySection.tsx`: make a personal API key and show the setup text (one of the folded ways).
- `FlowDiagram.tsx`: the diagram of what goes into gitring and what comes out.
- `shared.tsx`: parts that the other files share (a narrow-screen hook, a remembered choice, a folded way, a copy field).
- `clients.ts`: the agent apps that the page names, and the Cursor install link.
