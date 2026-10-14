declare module 'foliate-js/epubcfi.js' {
  export interface CfiPart { index: number; id?: string; offset?: number }
  export type ParsedCfi = CfiPart[][] | { parent: CfiPart[][]; start: CfiPart[][]; end: CfiPart[][] };
  export function parse(cfi: string): ParsedCfi;
  export function fromRange(range: Range, filter?: (node: Node) => number): string;
  export function toRange(document: Document, cfi: ParsedCfi, filter?: (node: Node) => number): Range;
}
