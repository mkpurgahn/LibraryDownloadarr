import fsPromises from 'fs/promises';
import path from 'path';
import { Request, Response } from 'express';
import { fingerprintStat } from './mediaAccess';

export interface ByteRange {
  start: number;
  end: number;
}

export const parseRange = (header: string | undefined, size: number): ByteRange | null | 'invalid' => {
  if (!header) return null;
  if (!header.startsWith('bytes=') || header.includes(',')) return 'invalid';
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2]) || size <= 0) return 'invalid';

  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) {
      return 'invalid';
    }
    end = Math.min(end, size - 1);
  }
  return { start, end };
};

const contentDisposition = (filename: string): string => {
  const safeAscii = path.basename(filename).replace(/["\\\r\n]/g, '_').replace(/[^\x20-\x7E]/g, '_');
  return `attachment; filename="${safeAscii}"; filename*=UTF-8''${encodeURIComponent(path.basename(filename))}`;
};

export const streamLocalFile = async (
  req: Request,
  res: Response,
  filePath: string,
  filename: string,
  expectedFingerprint: string
): Promise<void> => {
  if (!expectedFingerprint) {
    throw new Error('Download ticket must be renewed');
  }
  const handle = await fsPromises.open(filePath, 'r');
  const stat = await handle.stat();
  if (!stat.isFile()) {
    await handle.close();
    throw new Error('Download file is unavailable');
  }
  if (fingerprintStat(filePath, stat) !== expectedFingerprint) {
    await handle.close();
    throw new Error('Download file changed since the ticket was issued');
  }

  const etag = `"${expectedFingerprint}"`;
  const ifRange = req.headers['if-range'];
  const rangeHeader = typeof ifRange === 'string' && ifRange !== etag
    ? undefined
    : req.headers.range;
  const range = parseRange(rangeHeader, stat.size);

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('ETag', etag);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', contentDisposition(filename));
  res.setHeader('Cache-Control', 'private, no-store');

  if (range === 'invalid') {
    await handle.close();
    res.setHeader('Content-Range', `bytes */${stat.size}`);
    res.status(416).end();
    return;
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? Math.max(0, stat.size - 1);
  const contentLength = stat.size === 0 ? 0 : end - start + 1;
  res.status(range ? 206 : 200);
  res.setHeader('Content-Length', String(contentLength));
  if (range) res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);

  if (req.method === 'HEAD' || stat.size === 0) {
    await handle.close();
    res.end();
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const stream = handle.createReadStream({ start, end, autoClose: true });
    let settled = false;
    const finish = (): void => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    const fail = (error: Error): void => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    const disconnect = (): void => {
      stream.destroy();
      finish();
    };
    req.once('aborted', disconnect);
    res.once('close', disconnect);
    stream.once('error', fail);
    res.once('error', fail);
    res.once('finish', finish);
    stream.pipe(res);
  });
};
