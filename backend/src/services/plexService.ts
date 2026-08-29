import axios, { AxiosRequestConfig } from 'axios';
import https from 'https';
import { parseString } from 'xml2js';
import { config } from '../config';
import { logger } from '../utils/logger';

const parseStringAsync = (xml: string, options: object): Promise<any> =>
  new Promise((resolve, reject) => {
    parseString(xml, options, (error, result) => error ? reject(error) : resolve(result));
  });

export interface PlexLibrary {
  key: string;
  title: string;
  type: string;
}

export interface PlexSubtitleTrack {
  id: string;
  index: number;
  subtitleIndex: number;
  language?: string;
  languageCode?: string;
  title: string;
  codec: string;
  forced: boolean;
  hearingImpaired: boolean;
  embedded: boolean;
  external: boolean;
  burnSupported?: boolean;
  key?: string;
  file?: string;
}

export interface PlexPart {
  id: number | string;
  key: string;
  duration?: number;
  file?: string;
  size?: number;
  container?: string;
  Stream?: any[];
  subtitles?: PlexSubtitleTrack[];
}

export interface PlexMedia {
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
  librarySectionID?: string;
  librarySectionTitle?: string;
  grandparentTitle?: string;
  grandparentRatingKey?: string;
  parentTitle?: string;
  index?: number;
  parentIndex?: number;
  parentRatingKey?: string;
  Media?: Array<{
    id: number;
    duration?: number;
    bitrate?: number;
    width?: number;
    height?: number;
    aspectRatio?: number;
    videoCodec?: string;
    videoResolution?: string;
    container?: string;
    videoFrameRate?: string;
    Part: PlexPart[];
  }>;
}

export interface PlexPinResponse {
  id: number;
  code: string;
}

export interface PlexAuthResponse {
  authToken: string;
  user: {
    id: number;
    uuid: string;
    email: string;
    username: string;
    title: string;
    thumb: string;
  };
}

export interface ExactServerConnection {
  serverUrl: string | null;
  accessToken: string | null;
  matched: boolean;
}

export class PlexServerAccessDeniedError extends Error {
  constructor() {
    super('Plex identity does not have access to the configured server');
    this.name = 'PlexServerAccessDeniedError';
  }
}

export class PlexAccountUnauthorizedError extends Error {
  constructor() {
    super('Plex account authorization is no longer valid');
    this.name = 'PlexAccountUnauthorizedError';
  }
}

const normalizeBaseUrl = (input: string): string => {
  const withProtocol = /^https?:\/\//i.test(input) ? input : `http://${input}`;
  const parsed = new URL(withProtocol);
  if (!parsed.port) parsed.port = parsed.protocol === 'https:' ? '443' : '32400';
  return parsed.toString().replace(/\/$/, '');
};

const axiosConfig = (headers?: Record<string, string>): AxiosRequestConfig => ({
  headers,
  httpsAgent: new https.Agent({ rejectUnauthorized: !config.plex.allowInsecureTls }),
});

const asArray = <T>(value: T | T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

export const enumerateSubtitles = (part: PlexPart): PlexSubtitleTrack[] => {
  let subtitleIndex = 0;
  return asArray(part.Stream)
    .filter(stream => Number(stream.streamType) === 3)
    .map((stream, arrayIndex) => {
      const ordinal = subtitleIndex++;
      const id = String(stream.id ?? stream.index ?? arrayIndex);
      const language = stream.language || undefined;
      const languageCode = stream.languageCode || undefined;
      const codec = String(stream.codec || '').toLowerCase();
      const forced = stream.forced === true || stream.forced === 1 || stream.forced === '1';
      const hearingImpaired =
        stream.hearingImpaired === true || stream.hearingImpaired === 1 ||
        stream.hearingImpaired === '1' || stream.sdh === true || stream.sdh === 1 ||
        stream.sdh === '1';
      const external = Boolean(stream.key || stream.file);
      const descriptors = [language || languageCode || 'Unknown', forced ? 'Forced' : '', hearingImpaired ? 'SDH' : '']
        .filter(Boolean);
      return {
        id,
        index: Number(stream.index ?? arrayIndex),
        subtitleIndex: ordinal,
        language,
        languageCode,
        title: stream.title || stream.displayTitle || descriptors.join(' - '),
        codec,
        forced,
        hearingImpaired,
        embedded: !external,
        external,
        key: stream.key || undefined,
        file: stream.file || undefined,
      };
    });
};

const decorateMetadata = (metadata: PlexMedia): PlexMedia => {
  for (const media of asArray(metadata?.Media)) {
    for (const part of asArray(media.Part)) {
      part.subtitles = enumerateSubtitles(part);
    }
  }
  return metadata;
};

export class PlexServerClient {
  readonly baseUrl: string;
  private readonly token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.token = token;
  }

  private async get(endpoint: string, params?: Record<string, unknown>): Promise<any> {
    const requestConfig = axiosConfig({
      'X-Plex-Token': this.token,
      Accept: 'application/json',
    });
    requestConfig.params = params;
    const response = await axios.get(`${this.baseUrl}${endpoint}`, requestConfig);
    return response.data;
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.get('/');
      return true;
    } catch {
      return false;
    }
  }

  async getServerIdentity(): Promise<{ machineIdentifier: string; friendlyName: string } | null> {
    try {
      const identity = await this.get('/identity');
      const machineIdentifier = identity?.MediaContainer?.machineIdentifier;
      if (!machineIdentifier) return null;
      const root = await this.get('/');
      return {
        machineIdentifier,
        friendlyName: root?.MediaContainer?.friendlyName || root?.MediaContainer?.title || 'Plex Server',
      };
    } catch (error) {
      logger.error('Failed to get server identity', { error });
      return null;
    }
  }

  async getLibraries(): Promise<PlexLibrary[]> {
    const data = await this.get('/library/sections');
    return asArray<any>(data?.MediaContainer?.Directory).map(dir => ({
      key: String(dir.key),
      title: String(dir.title),
      type: String(dir.type),
    }));
  }

  async getLibraryContent(libraryKey: string, viewType?: string): Promise<PlexMedia[]> {
    const endpoint = viewType === 'albums'
      ? `/library/sections/${encodeURIComponent(libraryKey)}/albums`
      : `/library/sections/${encodeURIComponent(libraryKey)}/all`;
    const data = await this.get(endpoint);
    return asArray<PlexMedia>(data?.MediaContainer?.Metadata).map(decorateMetadata);
  }

  async getMediaMetadata(ratingKey: string): Promise<PlexMedia> {
    const data = await this.get(`/library/metadata/${encodeURIComponent(ratingKey)}`);
    const metadata = asArray<PlexMedia>(data?.MediaContainer?.Metadata)[0];
    if (!metadata) throw new Error('Media not found or not accessible');
    return decorateMetadata(metadata);
  }

  async getChildren(ratingKey: string): Promise<PlexMedia[]> {
    const data = await this.get(`/library/metadata/${encodeURIComponent(ratingKey)}/children`);
    return asArray<PlexMedia>(data?.MediaContainer?.Metadata).map(decorateMetadata);
  }

  getSeasons(ratingKey: string): Promise<PlexMedia[]> {
    return this.getChildren(ratingKey);
  }

  getEpisodes(ratingKey: string): Promise<PlexMedia[]> {
    return this.getChildren(ratingKey);
  }

  getTracks(ratingKey: string): Promise<PlexMedia[]> {
    return this.getChildren(ratingKey);
  }

  async search(query: string): Promise<PlexMedia[]> {
    const data = await this.get('/search', { query });
    return asArray<PlexMedia>(data?.MediaContainer?.Metadata).map(decorateMetadata);
  }

  async getRecentlyAdded(limit = 20): Promise<PlexMedia[]> {
    const libraries = await this.getLibraries();
    if (libraries.length === 0) return [];
    const itemsPerLibrary = Math.ceil(limit / libraries.length) + 5;
    const results = await Promise.all(libraries.map(async library => {
      try {
        const data = await this.get(`/library/sections/${encodeURIComponent(library.key)}/recentlyAdded`, {
          'X-Plex-Container-Start': 0,
          'X-Plex-Container-Size': itemsPerLibrary,
        });
        return asArray<PlexMedia>(data?.MediaContainer?.Metadata).map(decorateMetadata);
      } catch (error) {
        logger.warn('Failed to get recently added from library', { library: library.key, error });
        return [];
      }
    }));
    return results.flat()
      .filter(item => item.addedAt)
      .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
      .slice(0, limit);
  }

  getResourceRequest(resourcePath: string): {
    url: string;
    headers: { 'X-Plex-Token': string };
    maxRedirects: 0;
  } {
    if (!resourcePath.startsWith('/') || resourcePath.startsWith('//')) {
      throw new Error('Plex resource path must be server-relative');
    }
    const base = new URL(this.baseUrl);
    const url = new URL(resourcePath, base);
    if (url.origin !== base.origin) {
      throw new Error('Plex resource path must remain on the configured server');
    }
    return {
      url: url.toString(),
      headers: { 'X-Plex-Token': this.token },
      maxRedirects: 0,
    };
  }
}

export class PlexService {
  createServerClient(serverUrl: string, token: string): PlexServerClient {
    return new PlexServerClient(serverUrl, token);
  }

  async generatePin(): Promise<PlexPinResponse> {
    const response = await axios.post('https://plex.tv/api/v2/pins?strong=true', {}, {
      headers: {
        Accept: 'application/json',
        'X-Plex-Product': config.plex.product,
        'X-Plex-Client-Identifier': config.plex.clientIdentifier,
      },
    });
    return { id: response.data.id, code: response.data.code };
  }

  async checkPin(pinId: number): Promise<PlexAuthResponse | null> {
    try {
      const response = await axios.get(`https://plex.tv/api/v2/pins/${pinId}`, {
        headers: {
          Accept: 'application/json',
          'X-Plex-Client-Identifier': config.plex.clientIdentifier,
        },
      });
      if (!response.data.authToken) return null;
      const userInfo = await this.getUserInfo(response.data.authToken).catch(() => ({}));
      const username =
        userInfo.friendlyName || userInfo.friendly_name || userInfo.username ||
        response.data.username || response.data.title || `plexuser_${response.data.id}`;
      return {
        authToken: response.data.authToken,
        user: {
          id: response.data.id,
          uuid: String(userInfo.uuid || response.data.uuid || response.data.id),
          email: userInfo.email || response.data.email || '',
          username,
          title: response.data.title || username,
          thumb: response.data.thumb || '',
        },
      };
    } catch (error) {
      logger.error('Failed to check Plex PIN', { error });
      return null;
    }
  }

  async getUserInfo(token: string): Promise<any> {
    const response = await axios.get('https://plex.tv/api/v2/user', {
      headers: { 'X-Plex-Token': token, Accept: 'application/json' },
    });
    return response.data;
  }

  async getUserServers(userToken: string): Promise<any[]> {
    try {
      const response = await axios.get('https://plex.tv/api/resources', {
        headers: { 'X-Plex-Token': userToken },
        params: { includeHttps: '1', includeRelay: '1' },
      });
      const parsed = await parseStringAsync(response.data, { explicitArray: false, mergeAttrs: true });
      return asArray(parsed?.MediaContainer?.Device);
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 401) {
        throw new PlexAccountUnauthorizedError();
      }
      throw error;
    }
  }

  findBestServerConnection(servers: any[], targetMachineId?: string): ExactServerConnection {
    if (!targetMachineId) return { serverUrl: null, accessToken: null, matched: false };
    const target = servers.find(server =>
      String(server.provides || '').split(',').includes('server') &&
      server.clientIdentifier === targetMachineId &&
      (server.owned === true || server.owned === 1 || server.owned === '1' || Boolean(server.accessToken))
    );
    if (!target) return { serverUrl: null, accessToken: null, matched: false };

    const connections = asArray<any>(target.connections || target.Connection);
    const connection =
      connections.find(item => (item.local === true || item.local === 1 || item.local === '1') && item.uri) ||
      connections.find(item => item.uri);
    const shared = target.owned === false || target.owned === 0 || target.owned === '0';
    return {
      serverUrl: connection?.uri || null,
      accessToken: shared ? target.accessToken || null : null,
      matched: true,
    };
  }

  async validateExactServerMembership(
    accountToken: string,
    machineId: string
  ): Promise<{ serverToken: string; discoveredUrl: string }> {
    const servers = await this.getUserServers(accountToken);
    const connection = this.findBestServerConnection(servers, machineId);
    if (!connection.matched) {
      throw new PlexServerAccessDeniedError();
    }
    return {
      serverToken: connection.accessToken || accountToken,
      discoveredUrl: connection.serverUrl || '',
    };
  }

  async testConnectionWithCredentials(serverUrl: string, token: string): Promise<boolean> {
    return this.createServerClient(serverUrl, token).testConnection();
  }
}

export const plexService = new PlexService();
