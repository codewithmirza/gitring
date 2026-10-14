/**
 * Directory: the registry Durable Object of the whole deployment. It knows people, projects, roles and sign-in settings.
 *
 * The class is a chain of layers in src/directory/layers/. Each layer adds one area and builds on the one before it.
 * The HarborMaster of each project holds the project's state. The Directory only knows that the project exists.
 * Read next: src/directory/layers/README.md (the order of the layers, and which tables each one owns).
 */
import { DirectoryPasskeyAccounts } from "./layers/passkey-accounts";

export { GITHUB_HEADERS } from "./constants";
export { safeReturn } from "./helpers";
export type { GithubAppConfig, GithubRepoAccess, GithubUserToken, GithubUserTokenResult, GoogleConfig, ManifestConversion, ProvidersInfo } from "./types";

export class Directory extends DirectoryPasskeyAccounts {}
