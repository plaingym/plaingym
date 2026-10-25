// SPDX-License-Identifier: AGPL-3.0-only
declare module 'bidi-js' {
  interface Embedding { levels: Uint8Array; paragraphs: { start: number; end: number; level: number }[] }
  export default function bidi(): {
    getEmbeddingLevels(text: string, direction?: 'ltr' | 'rtl'): Embedding;
    getReorderSegments(text: string, embedding: Embedding, start?: number, end?: number): [number, number][];
    getMirroredCharactersMap(text: string, embedding: Embedding): Map<number, string>;
  };
}
