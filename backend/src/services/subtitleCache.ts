import axios from 'axios';
import fs from 'fs';
import fsPromises from 'fs/promises';
import https from 'https';
import path from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { config } from '../config';
import { fingerprintContents } from './mediaAccess';
import { PlexServerClient, PlexSubtitleTrack } from './plexService';
import { subtitleKind } from './subtitleSupport';

const MAXIMUM_SUBTITLE_BYTES = 50 * 1024 * 1024;

const validateTextResponse = async (filePath: string): Promise<void> => {
  const handle = await fsPromises.open(filePath, 'r');
  try {
    const sample = Buffer.alloc(512);
    const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
    const text = sample.subarray(0, bytesRead).toString('utf8').trimStart().toLowerCase();
    if (
      text.startsWith('<!doctype html') ||
      text.startsWith('<html') ||
      text.startsWith('<?xml')
    ) {
      throw new Error('Plex returned an error document instead of subtitle text');
    }
  } finally {
    await handle.close();
  }
};

export const cachePlexSubtitle = async (
  subtitle: PlexSubtitleTrack,
  client: PlexServerClient,
  cacheDir = config.burn.cacheDir
): Promise<void> => {
  if (!subtitle.external || subtitle.file) return;
  if (!subtitle.key || !subtitle.key.startsWith('/')) {
    throw new Error('External subtitle track has no resolvable Plex resource');
  }
  await fsPromises.mkdir(cacheDir, { recursive: true });
  const extension = subtitle.codec === 'subrip'
    ? 'srt'
    : subtitle.codec.replace(/[^a-z0-9]/gi, '') || 'sub';
  const workPath = path.join(
    cacheDir,
    `.subtitle-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.partial`
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.plex.requestTimeoutMs);
  try {
    const resource = client.getResourceRequest(subtitle.key);
    const response = await axios.get(resource.url, {
      headers: resource.headers,
      maxRedirects: resource.maxRedirects,
      responseType: 'stream',
      signal: controller.signal,
      timeout: config.plex.requestTimeoutMs,
      httpsAgent: new https.Agent({ rejectUnauthorized: !config.plex.allowInsecureTls }),
    });
    const declaredLength = Number(response.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > MAXIMUM_SUBTITLE_BYTES) {
      response.data.destroy();
      throw new Error('External subtitle exceeds the 50 MiB limit');
    }
    let receivedBytes = 0;
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        receivedBytes += chunk.length;
        callback(
          receivedBytes > MAXIMUM_SUBTITLE_BYTES
            ? new Error('External subtitle exceeds the 50 MiB limit')
            : null,
          chunk
        );
      },
    });
    await pipeline(response.data, limiter, fs.createWriteStream(workPath, { flags: 'wx' }));
    const stat = await fsPromises.stat(workPath);
    if (!stat.isFile() || stat.size === 0) {
      throw new Error('External subtitle download was empty');
    }
    if (subtitleKind(subtitle.codec) === 'text') {
      await validateTextResponse(workPath);
    }
    const contentFingerprint = await fingerprintContents(workPath);
    const finalPath = path.join(cacheDir, `subtitle-${contentFingerprint}.${extension}`);
    const existing = await fsPromises.stat(finalPath).catch(() => undefined);
    const existingFingerprint = existing?.isFile() && existing.size > 0
      ? await fingerprintContents(finalPath).catch(() => undefined)
      : undefined;
    if (existingFingerprint === contentFingerprint) {
      await fsPromises.rm(workPath, { force: true });
    } else {
      await fsPromises.rename(workPath, finalPath);
    }
    subtitle.file = finalPath;
  } catch (error) {
    await fsPromises.rm(workPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};
