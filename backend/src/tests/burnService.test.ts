import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { buildBurnCommand } from '../services/burnService';
import { PlexSubtitleTrack } from '../services/plexService';

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const options = { ffmpegPath: ffmpeg, encoder: 'libx264', qsvDevice: '' };
const subtitle: PlexSubtitleTrack = {
  id: 'english',
  index: 3,
  subtitleIndex: 1,
  language: 'English',
  languageCode: 'eng',
  title: 'English',
  codec: 'ass',
  forced: false,
  hearingImpaired: false,
  embedded: true,
  external: false,
};
let root: string;
let source: string;
let external: string;

const run = (args: string[]): Buffer => {
  const result = spawnSync(ffmpeg, ['-loglevel', 'error', '-nostdin', ...args], {
    timeout: 30000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr?.toString() || 'FFmpeg failed');
  return result.stdout;
};

const frame = (file: string): Buffer => run([
  '-i', file, '-ss', '0.5', '-frames:v', '1', '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1',
]);

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'librarydownloadarr-subtitles-'));
  source = path.join(root, 'source.mkv');
  external = path.join(root, 'english.ass');
  const english = path.join(root, 'english.srt');
  const inactive = path.join(root, 'inactive.srt');
  await fs.writeFile(english, '1\n00:00:00,000 --> 00:00:01,000\nVISIBLE ENGLISH SUBTITLES\n');
  await fs.writeFile(inactive, '1\n00:00:10,000 --> 00:00:11,000\nNOT THE SELECTED TRACK\n');
  run(['-i', english, external]);
  run([
    '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=6:d=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1',
    '-i', inactive, '-i', external,
    '-map', '0:v', '-map', '1:a', '-map', '2:s', '-map', '3:s',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-c:s', 'ass',
    '-t', '1', source,
  ]);
});

after(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

const names = [
  "#I'm Looking, [brackets]; equals= \u65e5\u672c\u8a9e",
  ...(process.platform === 'win32' ? [] : ["colon: back\\slash 'quoted', [x];"]),
];

test('text subtitle command escapes option and graph delimiters before hardware filters', () => {
  const file = "/media/it's: [English],;\\captions.ass";
  for (const [encoder, suffix] of [
    ['libx264', ''],
    ['h264_qsv', ',format=nv12'],
    ['h264_vaapi', ',format=nv12,hwupload'],
  ]) {
    const command = buildBurnCommand(
      '/media/input.mkv',
      'output.mp4',
      { ...subtitle, embedded: false, external: true, file },
      { ...options, encoder }
    );
    assert.equal(
      command.args[command.args.indexOf('-vf') + 1],
      String.raw`subtitles=filename=/media/it\\\'s\\:\\ \[English\]\,\;\\\\captions.ass` + suffix
    );
  }
});

for (const externalTrack of [false, true]) {
  test(`FFmpeg burns ${externalTrack ? 'external' : 'embedded'} ASS from literal filenames`, async () => {
    const track = externalTrack
      ? { ...subtitle, external: true, embedded: false, file: external }
      : subtitle;
    const reference = path.join(root, `reference-${externalTrack}.mp4`);
    run(buildBurnCommand(source, reference, track, options).args);
    const expected = frame(reference);
    const unburned = frame(source);
    assert.equal(expected.length, 320 * 180);
    assert(expected.some(pixel => pixel > 180), 'Selected subtitle must be visibly burned in');
    assert(unburned.every(pixel => pixel < 10), 'Original video must remain black');

    for (const [index, name] of names.entries()) {
      const directory = path.join(root, `${externalTrack}-${name}`);
      await fs.mkdir(directory);
      const namedSource = path.join(directory, `${name}.mkv`);
      const namedSubtitle = path.join(directory, `${name}.ass`);
      await fs.copyFile(source, namedSource);
      await fs.copyFile(external, namedSubtitle);
      const output = path.join(root, `burned-${externalTrack}-${index}.mp4`);
      const command = buildBurnCommand(
        namedSource,
        output,
        externalTrack ? { ...track, file: namedSubtitle } : track,
        options
      );
      assert.equal(command.args[command.args.indexOf('-i') + 1], namedSource);
      run(command.args);
      assert.deepEqual(frame(output), expected, `Burned frame must match for ${name}`);
      run(['-i', output, '-map', '0:a:0', '-f', 'null', '-']);
      assert.deepEqual(await fs.readFile(namedSource), await fs.readFile(source));
      assert.deepEqual(await fs.readFile(namedSubtitle), await fs.readFile(external));
    }
  });
}
