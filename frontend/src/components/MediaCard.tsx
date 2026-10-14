import React, { useEffect, useState } from 'react';
import { MediaItem } from '../types';
import { api } from '../services/api';
import { FilmIcon, TvIcon } from './Icons';

interface MediaCardProps {
  media: MediaItem;
  onClick: () => void;
}

export const MediaCard: React.FC<MediaCardProps> = ({ media, onClick }) => {
  const thumbnailUrl = media.thumb ? api.getThumbnailUrl(media.ratingKey, media.thumb) : null;
  const [missingArtwork, setMissingArtwork] = useState(false);
  useEffect(() => setMissingArtwork(false), [thumbnailUrl]);

  // Format display info based on media type
  const getDisplayInfo = () => {
    if (media.type === 'episode') {
      // Show: Show Name
      // Subtitle: S##E## - Episode Title (or just E## if no season number)
      const showName = media.grandparentTitle || 'Unknown Show';
      const seasonNum = media.parentIndex ? `S${String(media.parentIndex).padStart(2, '0')}` : '';
      const episodeNum = media.index ? `E${String(media.index).padStart(2, '0')}` : '';
      const episodeInfo = seasonNum ? `${seasonNum}${episodeNum}` : episodeNum;
      const subtitle = episodeInfo ? `${episodeInfo} - ${media.title}` : media.title;

      return {
        title: showName,
        subtitle,
        meta: media.parentTitle || null, // Season name
      };
    }

    if (media.type === 'track') {
      // Show: Album Name
      // Subtitle: Track Title
      const albumName = media.parentTitle || 'Unknown Album';
      return {
        title: albumName,
        subtitle: media.title,
        meta: media.grandparentTitle || null, // Artist name
      };
    }

    // For movies, shows, seasons, albums - show normally
    return {
      title: media.title,
      subtitle: null,
      meta: media.year?.toString() || null,
    };
  };

  const { title, subtitle, meta } = getDisplayInfo();

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={[title, subtitle, meta, media.contentRating].filter(Boolean).join(' - ')}
      className="media-card group min-w-0 text-left"
    >
      <div className="relative aspect-[2/3] overflow-hidden rounded-xl bg-dark-200">
        {thumbnailUrl && !missingArtwork ? (
          <img
            src={thumbnailUrl}
            alt=""
            className="w-full h-full object-cover"
            loading="lazy"
            onError={() => setMissingArtwork(true)}
          />
        ) : (
          <div className="w-full h-full flex flex-col gap-3 items-center justify-center px-3 text-center text-gray-400">
            {media.type === 'movie' ? (
              <FilmIcon className="h-10 w-10" />
            ) : (
              <TvIcon className="h-10 w-10" />
            )}
            <span className="text-sm">No artwork</span>
          </div>
        )}
      </div>
      <div className="pt-3">
        <h3 className="break-words text-base font-semibold leading-snug group-hover:text-primary-300">{title}</h3>
        {subtitle && <p className="mt-1 break-words text-sm leading-relaxed text-gray-400">{subtitle}</p>}
        {meta && <p className="mt-1 text-sm text-gray-400">{meta}</p>}
        {media.contentRating && <p className="mt-1 text-sm text-gray-400">{media.contentRating}</p>}
      </div>
    </button>
  );
};
