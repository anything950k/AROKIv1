export type AnimeStreamServer =
  | 'anikoto'
  | 'anikage'
  | 'miruro'
  | 'justanime'
  | 'kickassanime';

export const ANIME_SERVER_ORDER: AnimeStreamServer[] = [
  'anikoto',
  'anikage',
  'miruro',
  'justanime',
  'kickassanime',
];

export interface VideoStreamSource {
  url: string;
  rawUrl?: string;
  quality?: string;
  isM3U8?: boolean;
  server?: string;
  serverId?: string;
}

export interface SubtitleTrack {
  url: string;
  lang: string;
  label?: string;
  default?: boolean;
}

export interface ServerManifest {
  server: string;
  sources: VideoStreamSource[];
  subtitles?: SubtitleTrack[];
  intro?: { start: number; end: number };
  outro?: { start: number; end: number };
}

export interface ResolvedStreamPayload {
  success: boolean;
  servers: Record<AnimeStreamServer, ServerManifest>;
  activeServer: AnimeStreamServer;
  sources: VideoStreamSource[];
  subtitles?: SubtitleTrack[];
  intro?: { start: number; end: number };
  outro?: { start: number; end: number };
}

export const SERVER_METADATA: Record<
  AnimeStreamServer,
  { name: string; tag: string; desc: string; description?: string }
> = {
  anikoto: {
    name: 'Anikoto',
    tag: 'Primary Source',
    desc: 'Primary Anime HLS Stream',
    description: 'Primary Anime HLS Stream',
  },
  anikage: {
    name: 'Anikage',
    tag: 'Fallback 1',
    desc: 'Fallback 1 Anime Stream',
    description: 'Fallback 1 Anime Stream',
  },
  miruro: {
    name: 'Miruro',
    tag: 'Fallback 2',
    desc: 'Fallback 2 Anime Stream',
    description: 'Fallback 2 Anime Stream',
  },
  justanime: {
    name: 'JustAnime',
    tag: 'Fallback 3',
    desc: 'Fallback 3 Anime Stream',
    description: 'Fallback 3 Anime Stream',
  },
  kickassanime: {
    name: 'KickAssAnime',
    tag: 'Fallback 4',
    desc: 'Fallback 4 Anime Stream',
    description: 'Fallback 4 Anime Stream',
  },
};

function createEmptyServers(): Record<AnimeStreamServer, ServerManifest> {
  return {
    anikoto: { server: 'anikoto', sources: [], subtitles: [] },
    anikage: { server: 'anikage', sources: [], subtitles: [] },
    miruro: { server: 'miruro', sources: [], subtitles: [] },
    justanime: { server: 'justanime', sources: [], subtitles: [] },
    kickassanime: { server: 'kickassanime', sources: [], subtitles: [] },
  };
}

export async function resolveStreamWithFallbacks(
  anilistId: string | number,
  episodeNumber: number,
  title: string,
  audioTrack: 'sub' | 'dub' = 'sub',
  preferredServer: AnimeStreamServer = 'anikoto',
  altTitles: string[] = [],
  exactServerOnly = false
): Promise<ResolvedStreamPayload> {
  try {
    const res = await fetch('/api/anime/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        anilistId,
        episodeNumber,
        title,
        altTitles,
        audioTrack,
        preferredServer,
        exactServerOnly,
      }),
    });

    if (!res.ok) {
      return {
        success: false,
        servers: createEmptyServers(),
        activeServer: preferredServer,
        sources: [],
        subtitles: [],
      };
    }

    const data = await res.json();
    const empty = createEmptyServers();
    const servers: Record<AnimeStreamServer, ServerManifest> = {
      anikoto: data?.servers?.anikoto || empty.anikoto,
      anikage: data?.servers?.anikage || empty.anikage,
      miruro: data?.servers?.miruro || empty.miruro,
      justanime: data?.servers?.justanime || empty.justanime,
      kickassanime: data?.servers?.kickassanime || empty.kickassanime,
    };

    const activeServer: AnimeStreamServer =
      data?.activeServer && ANIME_SERVER_ORDER.includes(data.activeServer)
        ? data.activeServer
        : preferredServer;

    return {
      success: Boolean(data?.success),
      servers,
      activeServer,
      sources: Array.isArray(data?.sources) ? data.sources : [],
      subtitles: Array.isArray(data?.subtitles) ? data.subtitles : [],
      intro: data?.intro,
      outro: data?.outro,
    };
  } catch (err) {
    console.warn('resolveStreamWithFallbacks failed:', err);
    return {
      success: false,
      servers: createEmptyServers(),
      activeServer: preferredServer,
      sources: [],
      subtitles: [],
    };
  }
}
