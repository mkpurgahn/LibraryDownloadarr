import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

export type AudioFixtureMode = 'normal' | 'broken-middle' | 'm4b' | 'invalid-chapters';
interface AudioSample { bytes: Buffer; duration: number }
let pending: Promise<{ mp3: AudioSample[]; m4b: AudioSample }> | undefined;
export function audioFixtures(root: string): Promise<{ mp3: AudioSample[]; m4b: AudioSample }> {
  if (!pending) pending = (async () => {
    const directory = path.join(root, '.test-data', 'books', 'audio-fixtures', randomUUID());
    await fs.mkdir(directory, { recursive: true });
    const make = async (name: string, frequency: number, seconds: number, codec: string): Promise<AudioSample> => {
      const output = path.join(directory, name);
      await promisify(execFile)('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
        '-i', `sine=frequency=${frequency}:sample_rate=44100:duration=${seconds}`,
        '-af', 'volume=0.01', '-c:a', codec, '-b:a', '128k', '-map_metadata', '-1',
        ...(name.endsWith('.m4b') ? ['-movflags', '+faststart'] : []), output,
      ]);
      const result = await promisify(execFile)('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', output]);
      const parsed: { format?: { duration?: string } } = JSON.parse(result.stdout);
      const duration = Number(parsed.format?.duration);
      if (!Number.isFinite(duration) || duration <= 0) throw new Error('Generated audio fixture has no duration');
      return { bytes: await fs.readFile(output), duration };
    };
    const mp3 = [await make('first.mp3', 440, 4, 'libmp3lame'), await make('second.mp3', 660, 4, 'libmp3lame')];
    const m4b = await make('single.m4b', 550, 12, 'aac');
    return { mp3, m4b };
  })();
  return pending;
}
