import { ChildProcess, spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import readline from 'readline';
import { config } from '../config';
import { BurnJob, DatabaseService } from '../models/database';
import { logger } from '../utils/logger';
import { canonicalizeMediaPath, fingerprintContents, fingerprintFile } from './mediaAccess';
import { PlexSubtitleTrack } from './plexService';
import { subtitleKind } from './subtitleSupport';

export interface BurnOptions {
  ffmpegPath: string;
  encoder: string;
  qsvDevice: string;
  cacheDir: string;
  artifactTtlMs: number;
  globalConcurrency: number;
  perUserConcurrency: number;
}

export interface BurnCommand {
  executable: string;
  args: string[];
  kind: 'text' | 'bitmap';
}

const escapeFilterPath = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "'\\''").replace(/,/g, '\\,');

export const classifySubtitle = (codec: string): 'text' | 'bitmap' => {
  const kind = subtitleKind(codec);
  if (kind) return kind;
  throw new Error(`Unsupported subtitle codec: ${codec || 'unknown'}`);
};

export const buildBurnCommand = (
  sourcePath: string,
  outputPath: string,
  subtitle: PlexSubtitleTrack,
  options: Pick<BurnOptions, 'ffmpegPath' | 'encoder' | 'qsvDevice'>
): BurnCommand => {
  const kind = classifySubtitle(subtitle.codec);
  const usesQsv = options.encoder === 'h264_qsv';
  const usesVaapi = options.encoder === 'h264_vaapi';
  const softwareFilterSuffix = usesVaapi
    ? ',format=nv12,hwupload'
    : usesQsv
      ? ',format=nv12'
      : '';
  const args = ['-hide_banner', '-y'];
  if (usesQsv) args.push('-qsv_device', options.qsvDevice);
  if (usesVaapi) args.push('-vaapi_device', options.qsvDevice);
  args.push('-i', sourcePath);

  if (kind === 'text') {
    if (subtitle.external && !subtitle.file) {
      throw new Error('External subtitle track has no local file path');
    }
    const subtitlePath = subtitle.external ? subtitle.file! : sourcePath;
    const selector = subtitle.external ? '' : `:si=${subtitle.subtitleIndex}`;
    args.push(
      '-vf',
      `subtitles='${escapeFilterPath(subtitlePath)}'${selector}${softwareFilterSuffix}`,
      '-map',
      '0:v:0'
    );
  } else if (subtitle.external) {
    if (!subtitle.file) throw new Error('External bitmap subtitle track has no local file path');
    args.push(
      '-i',
      subtitle.file,
      '-filter_complex',
      `[0:v:0][1:0]overlay${softwareFilterSuffix}[v]`,
      '-map',
      '[v]'
    );
  } else {
    args.push(
      '-filter_complex',
      `[0:v:0][0:s:${subtitle.subtitleIndex}]overlay${softwareFilterSuffix}[v]`,
      '-map',
      '[v]'
    );
  }

  args.push(
    '-map', '0:a:0?',
    '-c:v', options.encoder,
    ...(usesVaapi ? ['-qp', '23'] : ['-pix_fmt', usesQsv ? 'nv12' : 'yuv420p']),
    '-c:a', 'aac',
    '-movflags', '+faststart',
    '-progress', 'pipe:2',
    '-nostats',
    '-f', 'mp4',
    outputPath
  );
  return { executable: options.ffmpegPath, args, kind };
};

export const burnCacheKey = (
  sourceFingerprint: string,
  subtitleStreamId: string,
  subtitleFingerprint: string,
  encoder: string,
  qsvDevice: string
): string => crypto.createHash('sha256')
  .update(
    `${sourceFingerprint}\0${subtitleStreamId}\0${subtitleFingerprint}\0${encoder}\0${qsvDevice}\0h264-aac-mp4-v1`
  )
  .digest('hex');

export class BurnManager {
  private readonly running = new Map<string, ChildProcess>();
  private readonly active = new Set<string>();
  private readonly activeCacheKeys = new Set<string>();
  private pumping = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly options: BurnOptions = config.burn
  ) {}

  async start(): Promise<void> {
    await fsPromises.mkdir(this.options.cacheDir, { recursive: true });
    this.db.resetInterruptedBurnJobs();
    await this.cleanupExpiredArtifacts();
    this.pump();
  }

  enqueue(job: BurnJob): void {
    if (job.status === 'queued') this.pump();
  }

  cancel(jobId: string, userId: string): { cancelled: boolean; job?: BurnJob } {
    const job = this.db.getBurnJob(jobId);
    if (!job || job.userId !== userId) return { cancelled: false };
    if (job.status === 'ready' || job.status === 'failed' || job.status === 'cancelled') {
      return { cancelled: false, job };
    }
    this.db.updateBurnJob(job.id, { status: 'cancelled', error: undefined });
    this.running.get(job.id)?.kill('SIGTERM');
    return { cancelled: true, job: this.db.getBurnJob(job.id) };
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    setImmediate(async () => {
      try {
        while (this.active.size < this.options.globalConcurrency) {
          const next = this.db.listQueuedBurnJobs().find(job =>
            job.status === 'queued' &&
            !this.activeCacheKeys.has(job.cacheKey) &&
            this.db.countPreparingBurnJobsForUser(job.userId) < this.options.perUserConcurrency
          );
          if (!next) break;
          this.active.add(next.id);
          this.activeCacheKeys.add(next.cacheKey);
          void this.run(next).finally(() => {
            this.active.delete(next.id);
            this.activeCacheKeys.delete(next.cacheKey);
            this.pump();
          });
        }
      } finally {
        this.pumping = false;
      }
    });
  }

  private async run(job: BurnJob): Promise<void> {
    const artifact = this.db.getArtifactByCacheKey(job.cacheKey);
    if (artifact && fs.existsSync(artifact.filePath)) {
      this.db.updateBurnJob(job.id, {
        status: 'ready', progress: 100, artifactId: artifact.id,
        filename: artifact.filename, size: artifact.size,
      });
      return;
    }

    const finalPath = path.join(this.options.cacheDir, `${job.cacheKey}.mp4`);
    const workPath = path.join(this.options.cacheDir, `.${job.id}.partial.mp4`);
    try {
      this.db.updateBurnJob(job.id, { status: 'preparing', progress: 1, error: undefined });
      const sourcePath = await canonicalizeMediaPath(job.sourcePath, config.media.roots);
      if (await fingerprintFile(sourcePath) !== job.sourceFingerprint) {
        throw new Error('Source media changed after the burn job was created');
      }
      const subtitle = JSON.parse(job.subtitleJson) as PlexSubtitleTrack;
      if (subtitle.external && subtitle.file) {
        subtitle.file = await canonicalizeMediaPath(
          subtitle.file,
          [...config.media.roots, this.options.cacheDir]
        );
        if (
          !job.subtitleFingerprint ||
          await fingerprintContents(subtitle.file) !== job.subtitleFingerprint
        ) {
          throw new Error('External subtitle changed after the burn job was created');
        }
      }
      const command = buildBurnCommand(sourcePath, workPath, subtitle, this.options);
      logger.info('Starting subtitle burn', {
        jobId: job.id, encoder: this.options.encoder, subtitleCodec: subtitle.codec,
      });
      await this.execute(job, command);
      if (this.db.getBurnJob(job.id)?.status === 'cancelled') {
        await fsPromises.rm(workPath, { force: true });
        return;
      }
      await fsPromises.rename(workPath, finalPath);
      const stat = await fsPromises.stat(finalPath);
      const artifactRecord = this.db.createArtifact({
        cacheKey: job.cacheKey,
        filePath: finalPath,
        filename: job.filename || `${path.parse(job.sourcePath).name}.subtitled.mp4`,
        size: stat.size,
        expiresAt: Date.now() + this.options.artifactTtlMs,
      });
      this.db.updateBurnJob(job.id, {
        status: 'ready', progress: 100, error: undefined,
        artifactId: artifactRecord.id, filename: artifactRecord.filename, size: stat.size,
      });
    } catch (error) {
      await fsPromises.rm(workPath, { force: true }).catch(() => undefined);
      if (this.db.getBurnJob(job.id)?.status !== 'cancelled') {
        this.db.updateBurnJob(job.id, {
          status: 'failed',
          error: error instanceof Error ? error.message : 'FFmpeg failed',
        });
      }
      logger.error('Subtitle burn failed', { jobId: job.id, error });
    }
  }

  private execute(job: BurnJob, command: BurnCommand): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(command.executable, command.args, { stdio: ['ignore', 'ignore', 'pipe'] });
      this.running.set(job.id, child);
      if (!child.stderr) {
        reject(new Error('FFmpeg stderr pipe was not created'));
        return;
      }
      const lines = readline.createInterface({ input: child.stderr });
      let lastError = '';
      lines.on('line', line => {
        lastError = `${lastError}\n${line}`.slice(-4000);
        const match = /^out_time_ms=(\d+)$/.exec(line);
        if (match && job.mediaDurationMs) {
          const elapsedMs = Number(match[1]) / 1000;
          const progress = Math.max(1, Math.min(99, Math.floor((elapsedMs / job.mediaDurationMs) * 100)));
          this.db.updateBurnJob(job.id, { progress });
        }
      });
      child.once('error', reject);
      child.once('close', code => {
        this.running.delete(job.id);
        lines.close();
        if (this.db.getBurnJob(job.id)?.status === 'cancelled') return resolve();
        if (code === 0) return resolve();
        reject(new Error(`FFmpeg exited with code ${code}: ${lastError.trim() || 'no diagnostic output'}`));
      });
    });
  }

  async cleanupExpiredArtifacts(): Promise<void> {
    const cacheRoot = await fsPromises.realpath(this.options.cacheDir).catch(() => this.options.cacheDir);
    for (const artifact of this.db.listExpiredArtifacts()) {
      const resolved = path.resolve(artifact.filePath);
      if (resolved === cacheRoot || resolved.startsWith(`${cacheRoot}${path.sep}`)) {
        await fsPromises.rm(resolved, { force: true }).catch(() => undefined);
      }
      this.db.deleteArtifact(artifact.id);
    }
    const entries = await fsPromises.readdir(cacheRoot, { withFileTypes: true }).catch(() => []);
    const cutoff = Date.now() - this.options.artifactTtlMs;
    for (const entry of entries) {
      if (!entry.isFile() || (!entry.name.startsWith('subtitle-') && !entry.name.includes('.partial'))) continue;
      const candidate = path.join(cacheRoot, entry.name);
      const stat = await fsPromises.stat(candidate).catch(() => undefined);
      if (stat && stat.mtimeMs <= cutoff) {
        await fsPromises.rm(candidate, { force: true }).catch(() => undefined);
      }
    }
  }
}
