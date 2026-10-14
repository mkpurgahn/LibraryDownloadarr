import React from 'react';
import { MediaItem } from '../types';
import { MediaCard } from './MediaCard';
import { useNavigate } from 'react-router-dom';

interface MediaGridProps {
  media: MediaItem[];
  isLoading?: boolean;
}

export const MediaGrid: React.FC<MediaGridProps> = ({ media, isLoading }) => {
  const navigate = useNavigate();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-gray-400">Loading...</div>
      </div>
    );
  }

  if (media.length === 0) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-gray-400">No media found</div>
      </div>
    );
  }

  return (
    <div className="media-grid grid items-start gap-x-4 gap-y-6 md:gap-x-5 md:gap-y-8">
      {media.map((item) => (
        <MediaCard
          key={item.ratingKey}
          media={item}
          onClick={() => navigate(`/media/${item.ratingKey}`)}
        />
      ))}
    </div>
  );
};
