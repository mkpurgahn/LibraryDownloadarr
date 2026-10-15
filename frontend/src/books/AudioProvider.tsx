import React, { createContext, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { booksApi, aborted, booksErrorMessage, BooksApiError, BOOKS_CHANGED_EVENT } from './api';
import { AudioLocator, BookItem } from './types';
import { ProgressClient, SaveState } from './progress';
import { audioDuration, resolveAudioTime, validateChapters } from './audioTimeline';
import { SESSION_CHANGED_EVENT } from '../stores/authStore';

export type AudioStatus = 'closed' | 'closing' | 'loading' | 'choose-position' | 'paused' | 'playing' | 'needs-gesture' | 'finished' | 'error';
export interface AudioState {
  item?: BookItem;
  fileId?: string;
  status: AudioStatus;
  position: number;
  duration: number;
  speed: number;
  wantsPlaying: boolean;
  compatible: boolean;
  hasSaved: boolean;
  saveState: SaveState;
  error?: string;
}
const initial = (): AudioState => ({
  status: 'closed', position: 0, duration: 0, speed: 1, wantsPlaying: false, compatible: true, hasSaved: false, saveState: 'unsaved',
});
interface AudioContextValue extends AudioState {
  open(item: BookItem): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  seek(seconds: number): Promise<void>;
  setSpeed(speed: number): void;
  resume(choice: 'saved' | 'start' | 'here'): Promise<void>;
  close(): void;
}
class OriginalAudioPlayer {
  private state = initial();
  private client?: ProgressClient;
  private controller = new AbortController();
  private epoch = 0;
  private loaded = false;
  private sourceUrl = '';
  private pendingClose: Promise<void> = Promise.resolve();
  private closingClient?: ProgressClient;
  private readonly timer: number;
  private readonly listeners: Array<[string, EventListener]> = [];
  private readonly sessionChanged = () => this.close(false);
  private readonly hidden = () => { if (document.visibilityState === 'hidden') this.save(); };

  constructor(private readonly audio: HTMLAudioElement, private readonly notify: (state: AudioState) => void) {
    const listen = (event: string, handler: EventListener) => {
      this.listeners.push([event, handler]); audio.addEventListener(event, handler);
    };
    listen('timeupdate', () => { if (this.loaded && this.state.status !== 'finished') this.position(); });
    listen('seeked', () => { if (this.loaded) { this.position(); this.save(); } });
    listen('playing', () => { if (this.loaded && this.state.wantsPlaying) this.update({ status: 'playing' }); });
    listen('pause', () => {
      if (this.loaded && this.state.status === 'playing' && !audio.ended) {
        this.update({ status: 'paused', wantsPlaying: false }); this.save();
      }
    });
    listen('waiting', () => {
      if (this.loaded && this.state.wantsPlaying) this.update({ status: 'loading' });
    });
    listen('ended', () => { void this.ended(); });
    listen('error', () => {
      if (this.sourceUrl && audio.src === this.sourceUrl && audio.error) {
        this.fail(new Error('This original track could not be loaded or decoded. Reload the audiobook or download the original.'));
      }
    });
    this.timer = window.setInterval(() => {
      if (this.state.status === 'playing') { this.position(); this.save(); }
    }, 10000);
    window.addEventListener(SESSION_CHANGED_EVENT, this.sessionChanged);
    window.addEventListener(BOOKS_CHANGED_EVENT, this.sessionChanged);
    window.addEventListener('pagehide', this.hidden);
    document.addEventListener('visibilitychange', this.hidden);
  }
  private update(patch: Partial<AudioState>): void { this.state = { ...this.state, ...patch }; this.notify(this.state); }
  private locator(final = false): AudioLocator | undefined {
    const track = this.state.item?.tracks.find(track => track.fileId === this.state.fileId);
    if (!track || !this.loaded || !Number.isFinite(this.audio.currentTime)) return undefined;
    const localSeconds = final ? track.duration : Math.max(0, Math.min(track.duration, this.audio.currentTime));
    return { kind: 'audio', trackId: track.fileId, localSeconds, globalSeconds: track.startOffset + localSeconds };
  }
  private position(final = false): void {
    const locator = this.locator(final);
    if (!locator) return;
    if (this.client) this.client.location = locator;
    this.update({ position: locator.globalSeconds });
  }
  private save(): void {
    if (!this.client || !this.loaded || ['closed', 'closing', 'error', 'choose-position'].includes(this.state.status)) return;
    const locator = this.state.status === 'finished' ? this.locator(true) : this.locator();
    if (locator) void this.client.save(locator);
  }
  private stopSource(): void {
    this.epoch += 1; this.controller.abort(); this.controller = new AbortController();
    this.loaded = false; this.sourceUrl = '';
    this.audio.pause(); this.audio.removeAttribute('src'); this.audio.load();
  }
  close(persist = true): void {
    const client = this.client;
    const location = this.state.status === 'finished' ? this.locator(true) : this.locator();
    this.client = undefined; this.stopSource();
    const speed = persist ? this.state.speed : 1;
    if (!persist) { this.closingClient?.dispose(); this.closingClient = undefined; }
    if (persist && client && location) {
      const epoch = this.epoch;
      this.closingClient = client;
      this.update({ status: 'closing', wantsPlaying: false, position: location.globalSeconds });
      const finish = (saved: boolean) => {
        if (this.epoch !== epoch || this.client) return;
        this.state = { ...initial(), speed, ...(saved ? {} : { error: 'The last listening position could not be saved.' }) };
        this.notify(this.state);
      };
      this.pendingClose = client.save(location).then(result => finish(result === 'saved'), () => finish(false)).finally(() => {
        client.dispose();
        if (this.closingClient === client) this.closingClient = undefined;
      });
    } else {
      client?.dispose(); this.state = { ...initial(), speed }; this.notify(this.state);
    }
  }
  private fail(error: unknown): void {
    if (aborted(error)) return;
    this.stopSource();
    this.update({ status: 'error', wantsPlaying: false, error: booksErrorMessage(error) });
  }
  async open(requested: BookItem): Promise<void> {
    this.close();
    const epoch = ++this.epoch;
    this.update({ item: requested, status: 'loading', error: undefined });
    try {
      await this.pendingClose;
      if (epoch !== this.epoch) return;
      const item = await booksApi.item(requested.itemId, this.controller.signal);
      if (epoch !== this.epoch) return;
      if (!item.listen.available || !item.audioEdition) throw new Error(item.listen.reason ?? 'This audiobook is download-only.');
      const duration = audioDuration(item.tracks);
      item.chapters = validateChapters(item.chapters, duration);
      const client = new ProgressClient(item, 'audio', item.audioEdition.editionId, item.audioEdition.contentVersion);
      this.client = client;
      this.update({ item, duration, fileId: item.tracks[0].fileId, position: 0 });
      client.subscribe(saveState => {
        if (this.client !== client) return;
        this.update({ saveState, compatible: client.compatible, hasSaved: Boolean(client.current) });
        if (saveState === 'conflict') {
          this.update({ status: 'choose-position', wantsPlaying: false }); this.audio.pause();
        }
      });
      const saved = await client.load();
      if (this.client !== client) return;
      this.update({ hasSaved: Boolean(saved), compatible: client.compatible });
      if (saved || !client.compatible) this.update({ status: 'choose-position' });
      else await this.resume('start');
    } catch (error) { if (epoch === this.epoch) this.fail(error); }
  }
  async resume(choice: 'saved' | 'start' | 'here'): Promise<void> {
    const client = this.client; const item = this.state.item;
    if (!client || !item) return;
    try {
      const here = this.locator();
      await client.load();
      if (this.client !== client) return;
      const saved = client.current?.locator;
      const seconds = choice === 'here' && here ? here.globalSeconds :
        choice === 'saved' && client.compatible && saved?.kind === 'audio' ? saved.globalSeconds : 0;
      const target = resolveAudioTime(item.tracks, seconds);
      const track = item.tracks.find(track => track.fileId === target.fileId)!;
      const locator: AudioLocator = { kind: 'audio', trackId: target.fileId, localSeconds: target.localSeconds, globalSeconds: track.startOffset + target.localSeconds };
      await client.claim(locator, client.revision);
      if (this.client !== client) return;
      this.update({ status: 'loading', wantsPlaying: true, compatible: true, error: undefined });
      await this.loadTrack(target.fileId, target.localSeconds, true);
    } catch (error) {
      if (this.client !== client || aborted(error)) return;
      if (error instanceof BooksApiError && error.status === 409) {
        this.update({ status: 'choose-position', wantsPlaying: false, compatible: client.compatible, error: error.message });
      } else this.fail(error);
    }
  }
  private async loadTrack(fileId: string, seconds: number, shouldPlay: boolean): Promise<void> {
    const item = this.state.item;
    const file = item?.files.find(file => file.fileId === fileId && file.available && file.role === 'audio');
    const track = item?.tracks.find(track => track.fileId === fileId);
    if (!item || !file || !track || !['mp3', 'm4b'].includes(file.extension)) throw new Error('This original track is download-only.');
    if (!this.audio.canPlayType(file.extension === 'm4b' ? 'audio/mp4' : 'audio/mpeg')) throw new Error('This browser cannot play the original format. Download the original.');
    this.controller.abort(); this.controller = new AbortController(); const controller = this.controller;
    const epoch = ++this.epoch;
    this.loaded = false;
    this.update({ fileId, position: track.startOffset + seconds, status: 'loading', error: undefined });
    await booksApi.mediaSession(controller.signal);
    if (epoch !== this.epoch || controller.signal.aborted) return;
    const url = new URL(booksApi.contentUrl({ itemId: item.itemId, fileId, contentVersion: file.contentVersion }), window.location.origin).href;
    this.sourceUrl = url;
    const metadata = new Promise<void>((resolve, reject) => {
      const clear = () => {
        this.audio.removeEventListener('loadedmetadata', ready);
        this.audio.removeEventListener('error', failed);
        controller.signal.removeEventListener('abort', cancelled);
      };
      const ready = () => { if (this.audio.currentSrc === url) { clear(); resolve(); } };
      const failed = () => { clear(); reject(new Error('This original track cannot be decoded here. Download the original.')); };
      const cancelled = () => { clear(); reject(new DOMException('Audio request cancelled', 'AbortError')); };
      this.audio.addEventListener('loadedmetadata', ready);
      this.audio.addEventListener('error', failed);
      controller.signal.addEventListener('abort', cancelled, { once: true });
    });
    this.audio.src = url; this.audio.load();
    await metadata;
    if (epoch !== this.epoch || controller.signal.aborted) return;
    if (!Number.isFinite(this.audio.duration) || this.audio.duration <= 0 ||
        Math.abs(this.audio.duration - track.duration) > Math.max(0.25, Math.min(1, track.duration * 0.001))) {
      throw new Error('The original audio timing differs from the catalog. Reload the audiobook or download the original.');
    }
    this.audio.playbackRate = this.state.speed;
    this.audio.currentTime = Math.min(seconds, this.audio.duration);
    this.loaded = true;
    this.update({ status: 'paused' }); this.position(); this.save();
    if (shouldPlay && this.state.wantsPlaying) await this.tryPlay();
  }
  private async tryPlay(): Promise<void> {
    const epoch = this.epoch;
    try {
      await this.audio.play();
      if (epoch === this.epoch && this.state.wantsPlaying && !this.audio.ended) this.update({ status: 'playing', error: undefined });
    } catch (error) {
      if (epoch !== this.epoch || !this.state.wantsPlaying) return;
      if (error instanceof DOMException && ['NotAllowedError', 'AbortError'].includes(error.name)) {
        this.update({ status: 'needs-gesture', wantsPlaying: false,
          error: error.name === 'NotAllowedError' ? 'Playback needs your permission. Tap to resume.' : 'Playback was interrupted. Tap to resume.' });
      } else this.fail(error);
    }
  }
  async play(): Promise<void> {
    if (!this.state.item || !this.loaded || this.state.status === 'choose-position' || this.state.status === 'error') return;
    this.update({ wantsPlaying: true });
    await this.tryPlay();
  }
  pause(): void {
    if (!this.state.item) return;
    this.position(); this.save();
    this.update({ wantsPlaying: false, ...(this.loaded && this.state.status !== 'finished' ? { status: 'paused' } : {}) });
    this.audio.pause();
  }
  async seek(seconds: number): Promise<void> {
    const item = this.state.item;
    if (!item || !this.client || this.state.status === 'choose-position') return;
    const resume = this.state.wantsPlaying;
    try {
      const target = resolveAudioTime(item.tracks, seconds);
      if (target.fileId !== this.state.fileId || !this.loaded) await this.loadTrack(target.fileId, target.localSeconds, resume);
      else {
        this.audio.currentTime = Math.min(target.localSeconds, this.audio.duration);
        this.position(); this.save();
        if (this.state.status === 'finished') this.update({ status: 'paused' });
        if (resume) await this.tryPlay();
      }
    } catch (error) { this.fail(error); }
  }
  setSpeed(speed: number): void {
    if (!Number.isFinite(speed)) { this.fail(new Error('Choose a valid playback speed.')); return; }
    const value = Math.max(0.5, Math.min(2, speed));
    this.audio.playbackRate = value; this.update({ speed: value });
  }
  private async ended(): Promise<void> {
    const item = this.state.item;
    if (!this.loaded || !item || !this.state.wantsPlaying) return;
    this.position(true); this.save();
    const index = item.tracks.findIndex(track => track.fileId === this.state.fileId);
    if (index === item.tracks.length - 1) {
      this.update({ status: 'finished', wantsPlaying: false, position: this.state.duration }); this.save(); return;
    }
    try { await this.loadTrack(item.tracks[index + 1].fileId, 0, true); } catch (error) { this.fail(error); }
  }
  dispose(): void {
    this.close(false); window.clearInterval(this.timer);
    for (const [event, handler] of this.listeners) this.audio.removeEventListener(event, handler);
    window.removeEventListener(SESSION_CHANGED_EVENT, this.sessionChanged);
    window.removeEventListener(BOOKS_CHANGED_EVENT, this.sessionChanged);
    window.removeEventListener('pagehide', this.hidden);
    document.removeEventListener('visibilitychange', this.hidden);
  }
}
const AudioContext = createContext<AudioContextValue | null>(null);
export const useBookAudio = (): AudioContextValue => {
  const value = useContext(AudioContext);
  if (!value) throw new Error('Audiobook controls require AudioProvider');
  return value;
};
export const AudioProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, setState] = useState<AudioState>(initial);
  const audio = useRef<HTMLAudioElement>(null);
  const engine = useRef<OriginalAudioPlayer>();
  useLayoutEffect(() => {
    const player = new OriginalAudioPlayer(audio.current!, setState); engine.current = player;
    return () => { player.dispose(); engine.current = undefined; };
  }, []);
  const actions = useMemo(() => ({
    open: (item: BookItem) => engine.current!.open(item),
    play: () => engine.current!.play(),
    pause: () => engine.current!.pause(),
    seek: (seconds: number) => engine.current!.seek(seconds),
    setSpeed: (speed: number) => engine.current!.setSpeed(speed),
    resume: (choice: 'saved' | 'start' | 'here') => engine.current!.resume(choice),
    close: () => engine.current!.close(),
  }), []);
  return <AudioContext.Provider value={{ ...state, ...actions }}>
    <audio ref={audio} data-testid="books-audio" preload="metadata" className="hidden" />
    <div style={{ paddingBottom: state.item ? 'var(--books-player-height, 0px)' : undefined }}>{children}</div>
  </AudioContext.Provider>;
};
