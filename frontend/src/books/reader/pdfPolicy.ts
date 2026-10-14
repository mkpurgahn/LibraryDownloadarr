import { READ_LIMITS } from '../types';

export const PDF_LIMITS = { documentBytes: READ_LIMITS.pdf, pages: 5000, pagePixels: 16000000, cacheBytes: 128 * 1024 * 1024 } as const;
export class PdfLimitError extends Error {}
export class PdfCacheBudget {
  used = 0;
  peak = 0;
  constructor(private readonly changed: (used: number, peak: number) => void = () => {}) {}
  adjust(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || this.used + bytes < 0 || this.used + bytes > PDF_LIMITS.cacheBytes) {
      throw new PdfLimitError('PDF reader cache limit reached; download the original.');
    }
    this.used += bytes; this.peak = Math.max(this.peak, this.used); this.changed(this.used, this.peak);
  }
  reserve(bytes: number): () => void {
    this.adjust(bytes); let active = true;
    return () => { if (active) { active = false; this.adjust(-bytes); } };
  }
}
