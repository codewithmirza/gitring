/**
 * Defines CliError, the one error that a command throws to stop with a plain message and an exit code.
 * main() in cli/gitring.mjs catches it. Any other error becomes "The command line stopped with an error".
 * Never put a token, a key or a response body in the message.
 */

export class CliError extends Error {
  /** 1: the command did not finish. 2: the command line is wrong. */
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}
