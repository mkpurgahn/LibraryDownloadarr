import React, { useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useBookAudio } from './AudioProvider';
import { useDownloads } from '../contexts/DownloadContext';
import { booksErrorMessage } from './api';

const duration = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
export const AudioPlayer: React.FC = () => {
  const state = useBookAudio();
  const { startBookDownloads } = useDownloads();
  const panel = useRef<HTMLElement>(null);
  const title = useRef<HTMLAnchorElement>(null);
  const [notice, setNotice] = useState('');
  useLayoutEffect(() => {
    if (!panel.current || !state.item) return;
    const size = () => document.documentElement.style.setProperty('--books-player-height', `${panel.current?.offsetHeight ?? 0}px`);
    size(); title.current?.focus({ preventScroll: true });
    const observer = new ResizeObserver(size); observer.observe(panel.current);
    return () => { observer.disconnect(); document.documentElement.style.removeProperty('--books-player-height'); };
  }, [state.item?.itemId]);
  if (!state.item) return state.error ? <aside role="alert" className="fixed inset-x-3 bottom-3 z-40 rounded-lg bg-dark-100 p-4 text-amber-200">
    {state.error}<button className="btn-secondary ml-3 min-h-11" onClick={state.close}>Dismiss</button>
  </aside> : null;
  const item = state.item;
  const file = item.files.find(file => file.fileId === state.fileId);
  const choose = state.status === 'choose-position';
  const unavailable = ['closing', 'loading', 'error', 'choose-position'].includes(state.status);
  const chapter = item.chapters.findIndex(chapter => state.position >= chapter.start && state.position < chapter.end);
  const original = async () => {
    if (!file) return;
    setNotice('');
    try {
      const result = await startBookDownloads([{
        source: 'abs', providerInstanceId: item.providerInstanceId, libraryId: item.libraryId,
        itemId: item.itemId, fileId: file.fileId, contentVersion: file.contentVersion, title: item.title, filename: file.basename,
      }]);
      setNotice(result.started ? 'Original sent to your browser; completion is not confirmed.' : 'Original needs attention in Download activity.');
    } catch (error) { setNotice(booksErrorMessage(error)); }
  };
  return <section ref={panel} role="region" aria-label="Audiobook player"
    className="fixed inset-x-0 bottom-0 z-40 border-t border-white/10 bg-dark-100 p-3 shadow-2xl"
    style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}>
    <div className="mx-auto max-w-6xl space-y-2">
      <div className="flex items-center justify-between gap-3">
        <Link ref={title} tabIndex={0} to={`/audiobooks/items/${item.itemId}`} className="min-w-0 truncate font-semibold text-primary-300">{item.title}</Link>
        <button className="btn-secondary min-h-11" disabled={state.status === 'closing'} onClick={state.close} aria-label="Close audiobook">Close</button>
      </div>
      {state.error && <p role="alert" className="text-sm text-amber-200">{state.error}</p>}
      {choose ? <div className="flex flex-wrap items-center gap-2">
        <p className="w-full text-sm text-gray-300">{!state.compatible ? 'The original track set changed. The previous position is retained; start this edition from the beginning.' :
          state.saveState === 'conflict' ? 'Another device owns the saved position. Choose how to continue.' : 'A private listening position is available.'}</p>
        {state.compatible && state.hasSaved && <button className="btn-primary min-h-11" onClick={() => void state.resume('saved')}>Resume saved position</button>}
        {state.compatible && state.saveState === 'conflict' && <button className="btn-secondary min-h-11" onClick={() => void state.resume('here')}>Continue here</button>}
        <button className="btn-secondary min-h-11" onClick={() => void state.resume('start')}>Start from beginning</button>
      </div> : <div className="flex flex-wrap items-center gap-2">
        {state.status === 'error' ? <button className="btn-secondary min-h-11" onClick={() => void state.open(item)}>Reload audiobook</button> :
          state.status === 'finished' ? <button className="btn-primary min-h-11" onClick={() => void state.resume('start')}>Play from beginning</button> :
            state.wantsPlaying ? <button className="btn-primary min-h-11" onClick={state.pause}>Pause</button> :
              <button className="btn-primary min-h-11" disabled={state.status === 'loading' || state.status === 'closing'} onClick={() => void state.play()}>
                {state.status === 'needs-gesture' ? 'Tap to resume' : 'Play'}
              </button>}
        <label className="flex min-w-0 items-center gap-2 text-sm">Track
          <select className="input min-h-11 max-w-[min(18rem,65vw)]" style={{ colorScheme: 'dark' }} disabled={choose || state.status === 'closing'}
            value={state.fileId ?? ''} onChange={event => {
              const track = item.tracks.find(track => track.fileId === event.target.value);
              if (track) void state.seek(track.startOffset);
            }}>
            {item.tracks.map((track, index) => <option key={track.fileId} value={track.fileId}>{index + 1}. {item.files.find(file => file.fileId === track.fileId)?.basename}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">Speed
          <select className="input min-h-11" style={{ colorScheme: 'dark' }} value={state.speed} onChange={event => state.setSpeed(Number(event.target.value))}>
            {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map(speed => <option key={speed} value={speed}>{speed}x</option>)}
          </select>
        </label>
        {file && <button className="btn-secondary min-h-11" disabled={state.status === 'closing'} onClick={() => void original()}>Download original track</button>}
      </div>}
      {item.chapters.length > 0 && !choose && <label className="flex items-center gap-2 text-sm">Chapter
        <select className="input min-h-11 max-w-md" style={{ colorScheme: 'dark' }} value={Math.max(0, chapter)} disabled={unavailable}
          onChange={event => { const target = item.chapters[Number(event.target.value)]; if (target) void state.seek(target.start); }}>
          {item.chapters.map((chapter, index) => <option key={`${chapter.id}-${index}`} value={index}>{chapter.title || `Chapter ${index + 1}`}</option>)}
        </select>
      </label>}
      {!item.chapters.length && !choose && <p className="text-xs text-gray-400">Chapters unavailable; use the track selector.</p>}
      <div className="flex items-center gap-3">
        <span className="min-w-12 text-sm tabular-nums" aria-label="Elapsed audio time">{duration(state.position)}</span>
        <input className="min-h-11 min-w-0 flex-1 accent-primary-500" type="range" min="0" max={state.duration} step="0.1"
          aria-label="Book position" aria-valuetext={`${duration(state.position)} of ${duration(state.duration)}`}
          disabled={unavailable} value={state.position} onChange={event => void state.seek(Number(event.target.value))} />
        <span className="text-sm tabular-nums" aria-label="Remaining audio time">-{duration(Math.max(0, state.duration - state.position))}</span>
      </div>
      <p role="status" className="text-xs text-gray-400">
        {state.status === 'closing' ? 'Saving listening position...' : state.status === 'finished' ? 'Finished. No other book will start.' : state.status === 'loading' ? 'Loading original audio...' :
          state.status === 'playing' ? 'Playing original audio.' : state.status === 'paused' ? 'Paused.' : ''}
        {' '}{state.status !== 'closing' && (state.saveState === 'saved' ? 'Listening position saved.' : state.saveState === 'conflict' ? 'Listening position changed on another device.' : 'Listening position not saved yet.')}
      </p>
      {notice && <p role="status" className="text-xs text-primary-200">{notice}</p>}
    </div>
  </section>;
};
