export interface User {
  id: string;
  username: string;
  email?: string;
  isAdmin: boolean;
}

export interface AuthResponse {
  user: User;
  token: string;
}

export interface Library {
  key: string;
  title: string;
  type: string;
}

export interface MediaItem {
  ratingKey: string;
  key: string;
  title: string;
  type: string;
  year?: number;
  thumb?: string;
  art?: string;
  summary?: string;
  rating?: number;
  duration?: number;
  addedAt?: number;
  updatedAt?: number;
  originallyAvailableAt?: string;
  studio?: string;
  contentRating?: string;
  // Episode/Season/Track context fields
  grandparentTitle?: string; // Show name for episodes, Artist for tracks
  grandparentRatingKey?: string;
  parentTitle?: string; // Season name for episodes, Album for tracks
  parentRatingKey?: string;
  index?: number; // Episode number or Track number
  parentIndex?: number; // Season number
  Media?: MediaPart[];
}

export interface MediaPart {
  id: number;
  duration: number;
  bitrate: number;
  width: number;
  height: number;
  aspectRatio: number;
  videoCodec: string;
  audioCodec?: string;
  audioChannels?: number;
  videoResolution: string;
  container: string;
  videoFrameRate: string;
  Part: Part[];
}

export interface MediaStream {
  id: number | string;
  index?: number;
  streamType?: number;
  streamTypeId?: number;
  codec?: string;
  language?: string;
  languageCode?: string;
  title?: string;
  displayTitle?: string;
  forced?: boolean;
  hearingImpaired?: boolean;
  key?: string;
  embedded?: boolean;
  burnSupported?: boolean;
}

export interface Part {
  id: number;
  key: string;
  duration: number;
  file?: string;
  size: number;
  container: string;
  Stream?: MediaStream[];
}

export interface DownloadTicket {
  url: string;
  expiresAt: string;
  filename: string;
}

export interface BatchDownloadTarget {
  ratingKey: string;
  partKey: string;
  filename: string;
  title: string;
}

export interface BatchDownloadTicket extends DownloadTicket {
  ratingKey: string;
  partKey: string;
}

export interface BatchDownloadResult {
  tickets: BatchDownloadTicket[];
  errors: Array<{
    ratingKey: string;
    partKey: string;
    error: string;
  }>;
}

export type BurnJobStatus = 'queued' | 'preparing' | 'ready' | 'failed' | 'cancelled';

export interface BurnJob {
  id: string;
  ratingKey: string;
  partKey: string;
  subtitleStreamId: number | string;
  status: BurnJobStatus;
  progress: number;
  filename?: string;
  size?: number;
  error?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface PlexPin {
  id: number;
  code: string;
  url: string;
}

export interface Settings {
  plexUrl: string;
  hasPlexToken: boolean;
  plexMachineId?: string;
  plexServerName?: string;
}
