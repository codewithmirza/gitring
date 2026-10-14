# plugins: the Claude Code plugin of gitring

`plugins/gitring/` is the plugin that `.claude-plugin/marketplace.json` lists. It is not part of the server. A person adds it to Claude Code so that an agent works through gitring.

- `gitring/.claude-plugin/plugin.json`: the name of the plugin, and the settings that Claude Code asks for: the address of gitring, the project and the API key.
- `gitring/.mcp.json`: connects Claude Code to the MCP endpoint of gitring, so that the gitring tools appear.
- `gitring/skills/gitring/SKILL.md`: the skill that tells an agent how to work through gitring: send a plan, apply each change request, run the tests, ask for a merge.
- `gitring/hooks/hooks.json`: runs the hook after each Write, Edit and MultiEdit.
- `gitring/hooks/gitring-hook.sh`: sends the event of the edit to gitring and prints the change requests that come back. It never blocks the agent and never fails.

The tests are in `test/mcp/plugin.test.ts`. The skill text follows the plain-words rules (`test/worker/copy-ste.test.ts`).
