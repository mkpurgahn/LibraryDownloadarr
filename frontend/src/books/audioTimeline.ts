import { BookItem } from './types';

export function audioDuration(tracks: BookItem['tracks']): number {
  if (!tracks.length) throw new Error('No original audio tracks are available.');
  let end = 0;
  const ids = new Set<string>();
  for (const track of tracks) {
    if (!track.fileId || ids.has(track.fileId) || !Number.isFinite(track.duration) || track.duration <= 0 ||
        !Number.isFinite(track.startOffset) || Math.abs(track.startOffset - end) > 0.05) {
      throw new Error('Audio timing is unavailable; download the originals.');
    }
    ids.add(track.fileId); end = track.startOffset + track.duration;
  }
  return end;
}
export function resolveAudioTime(tracks: BookItem['tracks'], globalSeconds: number): { fileId: string; localSeconds: number } {
  const total = audioDuration(tracks);
  if (!Number.isFinite(globalSeconds)) throw new Error('Choose a valid audio position.');
  const seconds = Math.max(0, Math.min(total, globalSeconds));
  const track = [...tracks].reverse().find(track => track.startOffset <= seconds) ?? tracks[0];
  return { fileId: track.fileId, localSeconds: Math.min(track.duration, Math.max(0, seconds - track.startOffset)) };
}
export function validateChapters(chapters: BookItem['chapters'], duration: number): BookItem['chapters'] {
  let end = 0;
  for (const chapter of chapters) {
    if (!Number.isFinite(chapter.start) || !Number.isFinite(chapter.end) || chapter.start < end ||
        chapter.end <= chapter.start || chapter.end > duration) return [];
    end = chapter.end;
  }
  return chapters;
}
