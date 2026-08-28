import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { DownloadChoice } from '../components/DownloadChoice';
import { Header } from '../components/Header';
import { Sidebar } from '../components/Sidebar';
import { useMobileMenu } from '../hooks/useMobileMenu';
import { api } from '../services/api';
import { MediaItem } from '../types';

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours > 0 ? `${hours}h ${remainder}m` : `${remainder}m`;
}

function PosterPlaceholder({ type }: { type: string }) {
  return (
    <div className="grid h-72 w-full max-w-[200px] place-items-center rounded-xl bg-dark-200 text-gray-500 md:h-96 md:w-64">
      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-14 w-14 fill-none stroke-current stroke-[1.5]">
        {type === 'movie' ? (
          <>
            <rect x="3" y="5" width="18" height="14" rx="2" />
            <path d="m8 9 5 3-5 3V9Z" strokeLinejoin="round" />
          </>
        ) : (
          <>
            <rect x="4" y="6" width="16" height="13" rx="2" />
            <path d="m9 3 3 3 3-3" strokeLinecap="round" strokeLinejoin="round" />
          </>
        )}
      </svg>
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={`h-5 w-5 fill-none stroke-current stroke-2 transition-transform ${open ? 'rotate-90' : ''}`}
    >
      <path d="m9 6 6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ItemDownloads({ item, compact = false }: { item: MediaItem; compact?: boolean }) {
  if (!item.Media?.length) {
    return <p className="text-sm text-gray-400">No downloadable file is available.</p>;
  }

  return (
    <div className="space-y-4">
      {item.Media.flatMap((mediaPart) =>
        mediaPart.Part.map((part) => (
          <DownloadChoice
            key={`${mediaPart.id}-${part.id}`}
            ratingKey={item.ratingKey}
            title={item.title}
            mediaPart={mediaPart}
            part={part}
            compact={compact}
          />
        ))
      )}
    </div>
  );
}

function EpisodeRow({ episode }: { episode: MediaItem }) {
  const thumbnail = episode.thumb ? api.getThumbnailUrl(episode.ratingKey, episode.thumb) : null;
  return (
    <article className="grid gap-4 border-t border-white/5 px-4 py-5 first:border-t-0 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,28rem)] lg:items-start">
      <div className="flex min-w-0 gap-3">
        {thumbnail && (
          <img
            src={thumbnail}
            alt=""
            className="h-16 w-24 flex-none rounded-lg object-cover sm:h-20 sm:w-32"
            loading="lazy"
          />
        )}
        <div className="min-w-0">
          <div className="font-medium text-white">
            {episode.index ? `Episode ${episode.index}: ` : ''}
            {episode.title}
          </div>
          <div className="mt-1 text-sm text-gray-400">
            {episode.duration ? formatDuration(episode.duration) : 'Episode'}
          </div>
          {episode.summary && (
            <p className="mt-2 line-clamp-2 text-sm leading-5 text-gray-400">{episode.summary}</p>
          )}
        </div>
      </div>
      <ItemDownloads item={episode} compact />
    </article>
  );
}

export const MediaDetail: React.FC = () => {
  const { ratingKey } = useParams<{ ratingKey: string }>();
  const { isMobileMenuOpen, toggleMobileMenu, closeMobileMenu } = useMobileMenu();
  const [media, setMedia] = useState<MediaItem | null>(null);
  const [seasons, setSeasons] = useState<MediaItem[]>([]);
  const [episodesBySeason, setEpisodesBySeason] = useState<Record<string, MediaItem[]>>({});
  const [expandedSeasons, setExpandedSeasons] = useState<Record<string, boolean>>({});
  const [tracks, setTracks] = useState<MediaItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  const loadMediaDetails = async () => {
    if (!ratingKey) return;
    setIsLoading(true);
    setError('');
    try {
      const metadata = await api.getMediaMetadata(ratingKey);
      setMedia(metadata);
      setSeasons(metadata.type === 'show' ? await api.getSeasons(ratingKey) : []);
      if (metadata.type === 'season') {
        const episodes = await api.getEpisodes(ratingKey);
        setEpisodesBySeason({ [ratingKey]: episodes });
        setExpandedSeasons({ [ratingKey]: true });
      }
      setTracks(metadata.type === 'album' ? await api.getTracks(ratingKey) : []);
    } catch (requestError: any) {
      setError(requestError.response?.data?.error || 'Media details could not be loaded.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadMediaDetails();
  }, [ratingKey]);

  const toggleSeason = async (seasonRatingKey: string) => {
    const willOpen = !expandedSeasons[seasonRatingKey];
    setExpandedSeasons((current) => ({ ...current, [seasonRatingKey]: willOpen }));
    if (!willOpen || episodesBySeason[seasonRatingKey]) return;
    try {
      const episodes = await api.getEpisodes(seasonRatingKey);
      setEpisodesBySeason((current) => ({ ...current, [seasonRatingKey]: episodes }));
    } catch (requestError: any) {
      setError(requestError.response?.data?.error || 'Episodes could not be loaded.');
    }
  };

  const shell = (content: React.ReactNode) => (
    <div className="flex min-h-screen flex-col">
      <Header onMenuClick={toggleMobileMenu} />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar isOpen={isMobileMenuOpen} onClose={closeMobileMenu} />
        {content}
      </div>
    </div>
  );

  if (isLoading) {
    return shell(
      <main className="grid flex-1 place-items-center p-8">
        <div className="text-sm text-gray-400">Loading download options...</div>
      </main>
    );
  }

  if (error || !media) {
    return shell(
      <main className="flex-1 p-4 md:p-8">
        <div className="mx-auto max-w-xl rounded-xl bg-red-500/10 p-5 text-red-100 ring-1 ring-red-400/20">
          <div className="font-medium">This title could not be opened</div>
          <p className="mt-1 text-sm leading-6 text-red-200">{error || 'Media not found.'}</p>
          <button type="button" className="btn-secondary mt-4" onClick={() => void loadMediaDetails()}>
            Try again
          </button>
        </div>
      </main>
    );
  }

  const posterUrl = media.thumb ? api.getThumbnailUrl(media.ratingKey, media.thumb) : null;
  const backdropUrl = media.art ? api.getThumbnailUrl(media.ratingKey, media.art) : null;

  return shell(
    <main className="min-w-0 flex-1 overflow-y-auto">
      {backdropUrl && (
        <div className="relative h-48 bg-cover bg-center md:h-96" style={{ backgroundImage: `url(${backdropUrl})` }}>
          <div className="absolute inset-0 bg-gradient-to-t from-dark via-dark/65 to-dark/10" />
        </div>
      )}

      <div className={`relative z-[1] p-4 md:p-8 ${backdropUrl ? '-mt-24 md:-mt-48' : ''}`}>
        <div className="mx-auto max-w-7xl">
          <div className="flex flex-col gap-6 md:flex-row md:gap-8">
            <div className="flex-none">
              {posterUrl ? (
                <img
                  src={posterUrl}
                  alt={`${media.title} poster`}
                  className="w-full max-w-[200px] rounded-xl shadow-2xl shadow-black/40 md:w-64"
                />
              ) : (
                <PosterPlaceholder type={media.type} />
              )}
            </div>

            <div className="min-w-0 flex-1">
              <h1 className="max-w-4xl text-balance text-3xl font-bold tracking-[-0.025em] text-white md:text-5xl">
                {media.title}
              </h1>
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-sm text-gray-300">
                {media.year && <span>{media.year}</span>}
                {media.contentRating && <span>{media.contentRating}</span>}
                {media.duration && <span>{formatDuration(media.duration)}</span>}
                {media.rating && <span>Rating {media.rating.toFixed(1)}</span>}
              </div>
              {media.summary && (
                <p className="mt-5 max-w-3xl text-base leading-7 text-gray-300">{media.summary}</p>
              )}

              <section className="mt-8">
                <div className="mb-4">
                  <h2 className="text-2xl font-semibold text-white">Download</h2>
                  <p className="mt-1 max-w-2xl text-sm leading-6 text-gray-400">
                    Original files start immediately. Subtitle burn-in is optional and creates a separate compatible copy.
                  </p>
                </div>

                {media.type === 'show' && (
                  <div className="space-y-4">
                    {seasons.map((season) => {
                      const open = Boolean(expandedSeasons[season.ratingKey]);
                      return (
                        <section key={season.ratingKey} className="overflow-hidden rounded-xl bg-dark-100 ring-1 ring-white/10">
                          <button
                            type="button"
                            onClick={() => void toggleSeason(season.ratingKey)}
                            className="flex min-h-16 w-full items-center gap-4 px-4 py-3 text-left transition-colors hover:bg-white/[0.03] focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary-500"
                            aria-expanded={open}
                          >
                            {season.thumb && (
                              <img
                                src={api.getThumbnailUrl(season.ratingKey, season.thumb)}
                                alt=""
                                className="h-16 w-11 rounded-md object-cover"
                                loading="lazy"
                              />
                            )}
                            <span className="min-w-0 flex-1">
                              <span className="block font-medium text-white">{season.title}</span>
                              <span className="mt-1 line-clamp-1 block text-sm text-gray-400">
                                {season.summary || 'Open to choose episodes and subtitles.'}
                              </span>
                            </span>
                            <span className="text-gray-400">
                              <Chevron open={open} />
                            </span>
                          </button>
                          {open && (
                            <div>
                              {episodesBySeason[season.ratingKey] ? (
                                episodesBySeason[season.ratingKey].map((episode) => (
                                  <EpisodeRow key={episode.ratingKey} episode={episode} />
                                ))
                              ) : (
                                <div className="border-t border-white/5 px-4 py-6 text-sm text-gray-400">
                                  Loading episodes...
                                </div>
                              )}
                            </div>
                          )}
                        </section>
                      );
                    })}
                    {seasons.length === 0 && <p className="text-sm text-gray-400">No seasons are available.</p>}
                  </div>
                )}

                {media.type === 'season' && (
                  <section className="overflow-hidden rounded-xl bg-dark-100 ring-1 ring-white/10">
                    {(episodesBySeason[ratingKey || ''] || []).map((episode) => (
                      <EpisodeRow key={episode.ratingKey} episode={episode} />
                    ))}
                  </section>
                )}

                {media.type === 'album' && (
                  <div className="space-y-3">
                    {tracks.map((track, index) => (
                      <article
                        key={track.ratingKey}
                        className="grid gap-4 rounded-xl bg-dark-100 p-4 ring-1 ring-white/10 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,28rem)]"
                      >
                        <div className="min-w-0">
                          <div className="text-sm text-gray-400">Track {index + 1}</div>
                          <div className="mt-1 font-medium text-white">{track.title}</div>
                          {track.duration && (
                            <div className="mt-1 text-sm text-gray-400">{formatDuration(track.duration)}</div>
                          )}
                        </div>
                        <ItemDownloads item={track} compact />
                      </article>
                    ))}
                  </div>
                )}

                {!['show', 'season', 'album'].includes(media.type) && (
                  <div className="space-y-4">
                    {media.Media?.map((mediaPart) => (
                      <section key={mediaPart.id} className="rounded-xl bg-dark-100 p-4 ring-1 ring-white/10 md:p-6">
                        <ItemDownloads item={{ ...media, Media: [mediaPart] }} />
                      </section>
                    ))}
                    {!media.Media?.length && <p className="text-sm text-gray-400">No download options are available.</p>}
                  </div>
                )}
              </section>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
};
