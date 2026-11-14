// SPDX-License-Identifier: AGPL-3.0-only
/** A verified snapshot-content failure; storage and programming errors must keep their own identity. */
export class SnapshotContentError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'SnapshotContentError'; }
}

/** Wrap only the parser, never the I/O that supplied its input. */
export function parseSnapshotJson(text: string): unknown {
  try { return JSON.parse(text) as unknown; }
  catch (error) {
    if (error instanceof SyntaxError) throw new SnapshotContentError('Invalid snapshot JSON', { cause: error });
    throw error;
  }
}
