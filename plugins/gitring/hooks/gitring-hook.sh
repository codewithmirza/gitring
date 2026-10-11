#!/bin/sh
# gitring hook for Claude Code (PostToolUse, after Write, Edit and MultiEdit).
#
# It sends the hook event (JSON on stdin) to gitring. gitring answers with the change requests for
# the agent, and Claude Code shows them in the session. The hook never blocks and never fails:
# without an address, a project or a key, it does nothing.
#
# Settings (an environment variable takes precedence over the plugin setting):
#   GITRING_URL      or the plugin setting gitring_url   the address of your gitring
#   GITRING_PROJECT  or the plugin setting project       the project id
#   GITRING_KEY      or the plugin setting api_key       a personal API key (member role)

url="${GITRING_URL:-$CLAUDE_PLUGIN_OPTION_GITRING_URL}"
project="${GITRING_PROJECT:-$CLAUDE_PLUGIN_OPTION_PROJECT}"
key="${GITRING_KEY:-$CLAUDE_PLUGIN_OPTION_API_KEY}"

[ -n "$url" ] && [ -n "$project" ] && [ -n "$key" ] || exit 0
command -v curl >/dev/null 2>&1 || exit 0

# The key goes through a private file, not through the command line (other users can read that).
header="$(mktemp 2>/dev/null)" || exit 0
trap 'rm -f "$header"' EXIT
printf 'Authorization: Bearer %s\n' "$key" > "$header"

curl -s --max-time 10 -X POST \
  -H 'content-type: application/json' \
  -H "@$header" \
  --data-binary @- \
  "${url%/}/hooks/claude/$project" 2>/dev/null || true
exit 0
