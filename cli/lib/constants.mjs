/**
 * Holds the fixed values of the command line: its version, its OAuth client and the protocol names.
 * Every file of cli/ that talks to a server reads them.
 * Never put a secret or the address of a server here.
 */

export const VERSION = "0.9.2";
/** gitring's own OAuth client (every gitring knows it: src/directory/device.ts). */
export const CLIENT_ID = "gitring-cli";
export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
export const MCP_VERSION = "2026-07-28";
export const TOO_OLD = "This gitring server is too old for this command.";
export const CREDENTIALS_FILE = "credentials.json";
