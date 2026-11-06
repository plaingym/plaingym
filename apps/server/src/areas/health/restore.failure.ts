// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A fixed, public diagnostic; never pass file contents, paths, keys or upstream error text as the message.
 * The optional cause is for the structured log, which keeps its name, code and frames and drops its message.
 */
export class RestoreFailure extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'RestoreFailure'; }
}
