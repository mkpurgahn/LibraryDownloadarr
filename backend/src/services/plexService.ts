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

export interface PlexOnlineSubtitleCandidate {
  id: string;
  key: string;
  codec: string;
  language?: string;
  languageCode?: string;
  title: string;
  displayTitle?: string;
  providerTitle?: string;
  score?: number;
  perfectMatch: boolean;
  forced: boolean;
  hearingImpaired: boolean;
  downloaded: boolean;
  transient?: boolean;
  mediaItemId?: string;
}

export interface PlexPart {
  id: number | string;
  key: string;
  duration?: number;
  file?: string;
  filename?: string;
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
    audioCodec?: string;
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

export interface PlexAccountIdentity {
  id: string;
  username: string;
}

export interface ExactServerConnection {
  serverUrl: string | null;
  accessToken: string | null;
  matched: boolean;
  owned: boolean;
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

export class PlexServerOwnershipRequiredError extends Error {
  constructor() {
    super('The configured Plex token must belong to the server owner');
    this.name = 'PlexServerOwnershipRequiredError';
  }
}

export class PlexSubtitleAttachError extends Error {
  constructor(
    message: string,
    readonly mayHaveStarted: boolean,
    readonly activityId?: string
  ) {
    super(message);
    this.name = 'PlexSubtitleAttachError';
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

const flag = (value: unknown): boolean =>
  value === true || value === 1 || value === '1';

const cleanText = (value: unknown, maximumLength: number): string | undefined => {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const cleaned = String(value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned ? cleaned.slice(0, maximumLength) : undefined;
};

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
      const forced = flag(stream.forced);
      const hearingImpaired = flag(stream.hearingImpaired) || flag(stream.sdh);
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

  private send(
    method: 'GET' | 'PUT' | 'DELETE',
    endpoint: string,
    params?: Record<string, unknown>,
    timeoutMs = config.plex.requestTimeoutMs
  ) {
    const requestConfig = axiosConfig({
      'X-Plex-Token': this.token,
      Accept: 'application/json',
      'X-Plex-Client-Identifier': config.plex.clientIdentifier,
      'X-Plex-Product': config.plex.product,
      'X-Plex-Version': config.plex.version,
      'X-Plex-Device': config.plex.device,
    });
    requestConfig.params = params;
    requestConfig.method = method;
    requestConfig.url = `${this.baseUrl}${endpoint}`;
    requestConfig.timeout = Math.max(1, timeoutMs);
    return axios.request(requestConfig);
  }

  private async request(
    method: 'GET' | 'PUT' | 'DELETE',
    endpoint: string,
    params?: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<any> {
    const response = await this.send(method, endpoint, params, timeoutMs);
    return response.data;
  }

  private get(
    endpoint: string,
    params?: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<any> {
    return this.request('GET', endpoint, params, timeoutMs);
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

  async getMediaMetadata(ratingKey: string, timeoutMs?: number): Promise<PlexMedia> {
    const data = await this.get(
      `/library/metadata/${encodeURIComponent(ratingKey)}`,
      undefined,
      timeoutMs
    );
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

  async searchSubtitles(
    ratingKey: string,
    options: { language: string; mediaItemId?: number | string }
  ): Promise<PlexOnlineSubtitleCandidate[]> {
    const data = await this.get(`/library/metadata/${encodeURIComponent(ratingKey)}/subtitles`, {
      language: options.language,
      mediaItemID: options.mediaItemId,
      hearingImpaired: 0,
      forced: 0,
    });
    return asArray<any>(data?.MediaContainer?.Stream)
      .map((stream): PlexOnlineSubtitleCandidate | undefined => {
        const key = cleanText(stream.key, 2048);
        const codec = cleanText(stream.codec, 32)?.toLowerCase();
        const id = cleanText(stream.id, 128);
        if (!key || !codec || !id || !key.startsWith('/library/streams/')) return undefined;
        try {
          this.getResourceRequest(key);
        } catch {
          return undefined;
        }
        const score = Number(stream.score);
        return {
          id,
          key,
          codec,
          language: cleanText(stream.language, 64),
          languageCode: cleanText(stream.languageCode, 16),
          title:
            cleanText(stream.title, 240) ||
            cleanText(stream.displayTitle, 240) ||
            'Untitled subtitle',
          displayTitle: cleanText(stream.displayTitle, 120),
          providerTitle: cleanText(stream.providerTitle, 80),
          score: Number.isFinite(score) ? score : undefined,
          perfectMatch: flag(stream.perfectMatch),
          forced: flag(stream.forced),
          hearingImpaired: flag(stream.hearingImpaired) || flag(stream.sdh),
          downloaded: flag(stream.downloaded),
          transient: stream.transient === undefined ? undefined : flag(stream.transient),
          mediaItemId: options.mediaItemId === undefined
            ? cleanText(stream.mediaItemID, 128)
            : String(options.mediaItemId),
        };
      })
      .filter((candidate): candidate is PlexOnlineSubtitleCandidate => Boolean(candidate));
  }

  async attachSubtitle(
    ratingKey: string,
    candidate: PlexOnlineSubtitleCandidate,
    timeoutMs?: number
  ): Promise<string | undefined> {
    this.getResourceRequest(candidate.key);
    try {
      const response = await this.send(
        'PUT',
        `/library/metadata/${encodeURIComponent(ratingKey)}/subtitles`,
        {
          key: candidate.key,
          codec: candidate.codec,
          language: candidate.languageCode || candidate.language,
          hearingImpaired: candidate.hearingImpaired ? 1 : 0,
          forced: candidate.forced ? 1 : 0,
          providerTitle: candidate.providerTitle,
          mediaItemID: candidate.mediaItemId,
          transient: 1,
        },
        timeoutMs
      );
      const activityId = response.headers['x-plex-activity'];
      return typeof activityId === 'string' && activityId.length <= 128
        ? activityId
        : undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Plex subtitle attachment failed';
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      const definitivelyRejected = status !== undefined && status >= 400 && status < 500 && status !== 408;
      const responseActivity = axios.isAxiosError(error)
        ? error.response?.headers?.['x-plex-activity']
        : undefined;
      const activityId = typeof responseActivity === 'string' && responseActivity.length <= 128
        ? responseActivity
        : undefined;
      throw new PlexSubtitleAttachError(message, !definitivelyRejected, activityId);
    }
  }

  async selectSubtitle(
    partId: number | string,
    streamId: number | string,
    timeoutMs?: number
  ): Promise<void> {
    if (!/^\d+$/.test(String(partId)) || !/^\d+$/.test(String(streamId))) {
      throw new Error('Plex part and subtitle stream identifiers must be numeric');
    }
    await this.request(
      'PUT',
      `/library/parts/${encodeURIComponent(String(partId))}`,
      { subtitleStreamID: String(streamId) },
      timeoutMs
    );
  }

  async deleteSubtitle(resourcePath: string, timeoutMs?: number): Promise<boolean> {
    if (!/^\/library\/streams\/\d+$/.test(resourcePath)) {
      throw new Error('Plex subtitle stream path is invalid');
    }
    this.getResourceRequest(resourcePath);
    try {
      await this.request('DELETE', resourcePath, undefined, timeoutMs);
      return true;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) return false;
      throw error;
    }
  }

  async cancelActivity(activityId: string, timeoutMs?: number): Promise<boolean> {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(activityId)) {
      throw new Error('Plex activity identifier is invalid');
    }
    try {
      await this.request(
        'DELETE',
        `/activities/${encodeURIComponent(activityId)}`,
        undefined,
        timeoutMs
      );
      return true;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) return false;
      throw error;
    }
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
    const response = await axios.get(`https://plex.tv/api/v2/pins/${pinId}`, {
      headers: {
        Accept: 'application/json',
        'X-Plex-Client-Identifier': config.plex.clientIdentifier,
      },
      timeout: config.plex.requestTimeoutMs,
    });
    if (!response.data.authToken) return null;

    const userInfo = await this.getUserInfo(response.data.authToken);
    const identity = this.accountIdentity(userInfo);
    return {
      authToken: response.data.authToken,
      user: {
        id: Number(userInfo.id) || response.data.id,
        uuid: identity.id,
        email: userInfo.email || '',
        username: identity.username,
        title: userInfo.title || identity.username,
        thumb: userInfo.thumb || '',
      },
    };
  }

  async getUserInfo(token: string): Promise<any> {
    const response = await axios.get('https://plex.tv/api/v2/user', {
      headers: { 'X-Plex-Token': token, Accept: 'application/json' },
      timeout: config.plex.requestTimeoutMs,
    });
    return response.data;
  }

  async getAccountIdentity(token: string): Promise<PlexAccountIdentity> {
    const account = await this.getUserInfo(token);
    return this.accountIdentity(account);
  }

  async getServerOwnerIdentity(
    token: string,
    machineId: string
  ): Promise<PlexAccountIdentity> {
    const [identity, servers] = await Promise.all([
      this.getAccountIdentity(token),
      this.getUserServers(token),
    ]);
    const server = servers.find(item =>
      String(item.provides || '').split(',').includes('server') &&
      item.clientIdentifier === machineId
    );
    if (!server || !flag(server.owned)) {
      throw new PlexServerOwnershipRequiredError();
    }
    return identity;
  }

  private accountIdentity(account: any): PlexAccountIdentity {
    const id = cleanText(account.uuid || account.id, 128);
    if (!id) {
      throw new Error('Plex account identity could not be verified');
    }
    return {
      id,
      username: cleanText(
        account.friendlyName || account.friendly_name || account.username || account.title,
        128
      ) || 'Plex owner',
    };
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
    if (!targetMachineId) {
      return { serverUrl: null, accessToken: null, matched: false, owned: false };
    }
    const target = servers.find(server =>
      String(server.provides || '').split(',').includes('server') &&
      server.clientIdentifier === targetMachineId &&
      (server.owned === true || server.owned === 1 || server.owned === '1' || Boolean(server.accessToken))
    );
    if (!target) {
      return { serverUrl: null, accessToken: null, matched: false, owned: false };
    }

    const connections = asArray<any>(target.connections || target.Connection);
    const connection =
      connections.find(item => (item.local === true || item.local === 1 || item.local === '1') && item.uri) ||
      connections.find(item => item.uri);
    const shared = target.owned === false || target.owned === 0 || target.owned === '0';
    return {
      serverUrl: connection?.uri || null,
      accessToken: shared ? target.accessToken || null : null,
      matched: true,
      owned: flag(target.owned),
    };
  }

  async validateExactServerMembership(
    accountToken: string,
    machineId: string
  ): Promise<{ serverToken: string; discoveredUrl: string; owned: boolean }> {
    const servers = await this.getUserServers(accountToken);
    const connection = this.findBestServerConnection(servers, machineId);
    if (!connection.matched) {
      throw new PlexServerAccessDeniedError();
    }
    return {
      serverToken: connection.accessToken || accountToken,
      discoveredUrl: connection.serverUrl || '',
      owned: connection.owned,
    };
  }

  async testConnectionWithCredentials(serverUrl: string, token: string): Promise<boolean> {
    return this.createServerClient(serverUrl, token).testConnection();
  }
}

export const plexService = new PlexService();
