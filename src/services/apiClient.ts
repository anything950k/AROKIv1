import {
  MediaItem,
  Character,
  ScheduleDay,
  FilterOptions,
  MediaCategory,
  EpisodeItem,
  MangaChapterItem,
  NovelChapterItem,
} from '../types';
import { swrGetSync, swrGet, swrSet, swrFetchDedupe } from './swrCache';

export function optimizeImageUrl(rawUrl?: string): string {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  let url = rawUrl.trim();
  if (!url) return '';
  if (url.startsWith('http://')) {
    url = url.replace('http://', 'https://');
  }
  return url;
}

async function fetchFromAniList<T>(query: string, variables: Record<string, any> = {}): Promise<T> {
  try {
    const response = await fetch('/api/anilist', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });

    if (response.ok) {
      const text = await response.text();
      if (text.trim().startsWith('{')) {
        const json = JSON.parse(text);
        if (json && json.data) {
          return json.data;
        }
      }
    }
  } catch {
    // Request failed
  }

  return { Page: { media: [], pageInfo: { total: 0 } } } as unknown as T;
}

// Clean HTML tags from AniList descriptions
function cleanDescription(desc?: string | null): string {
  if (!desc) return 'No synopsis available.';
  return desc
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?[^>]+(>|$)/g, '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .trim();
}

export interface ParsedCharacterData {
  attributes: { key: string; value: string }[];
  bio: string;
  rawDescription: string;
}

export function parseCharacterDescription(
  rawDesc: string | undefined | null,
  nativeProps?: {
    gender?: string;
    birthday?: string;
    age?: string;
    bloodType?: string;
  }
): ParsedCharacterData {
  if (!rawDesc) {
    const fallbackAttrs: { key: string; value: string }[] = [];
    if (nativeProps?.gender && nativeProps.gender !== 'Unknown') fallbackAttrs.push({ key: 'Gender', value: nativeProps.gender });
    if (nativeProps?.birthday) fallbackAttrs.push({ key: 'Birthday', value: nativeProps.birthday });
    if (nativeProps?.age && nativeProps.age !== 'Unknown') fallbackAttrs.push({ key: 'Age', value: nativeProps.age });
    if (nativeProps?.bloodType && nativeProps.bloodType !== 'Unknown') fallbackAttrs.push({ key: 'Blood Type', value: nativeProps.bloodType });
    return {
      attributes: fallbackAttrs,
      bio: 'No description available.',
      rawDescription: '',
    };
  }

  const lines = rawDesc.split(/\r?\n/);
  const parsedAttrs: { key: string; value: string }[] = [];
  const narrativeLines: string[] = [];
  let readingHeader = true;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    if (!trimmed) {
      if (parsedAttrs.length > 0) {
        readingHeader = false;
      }
      if (!readingHeader) {
        narrativeLines.push('');
      }
      continue;
    }

    if (readingHeader) {
      const cleanLine = trimmed.replace(/~!|!~/g, '').trim();
      const match = cleanLine.match(/^(?:__|[*]{2})?([A-Za-z0-9\s/'-]+?)(?:__|[*]{2})?:\s*(.+)$/);
      if (match && match[1].length < 35 && !match[1].includes('.') && !match[1].includes(',')) {
        const key = match[1].trim();
        const val = match[2]
          .trim()
          .replace(/~!|!~/g, '')
          .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
          .trim();
        parsedAttrs.push({ key, value: val });
        continue;
      } else {
        readingHeader = false;
      }
    }

    narrativeLines.push(rawLine);
  }

  const finalAttrs: { key: string; value: string }[] = [];
  const existingKeySet = new Set(parsedAttrs.map((a) => a.key.toLowerCase()));

  if (nativeProps?.gender && nativeProps.gender !== 'Unknown' && !existingKeySet.has('gender')) {
    finalAttrs.push({ key: 'Gender', value: nativeProps.gender });
  }
  if (nativeProps?.birthday && !existingKeySet.has('birthday')) {
    finalAttrs.push({ key: 'Birthday', value: nativeProps.birthday });
  }
  if (nativeProps?.age && nativeProps.age !== 'Unknown' && !existingKeySet.has('age')) {
    finalAttrs.push({ key: 'Age', value: nativeProps.age });
  }
  if (nativeProps?.bloodType && nativeProps.bloodType !== 'Unknown' && !existingKeySet.has('blood type')) {
    finalAttrs.push({ key: 'Blood Type', value: nativeProps.bloodType });
  }

  for (const attr of parsedAttrs) {
    finalAttrs.push(attr);
  }

  const bioText = narrativeLines.join('\n').trim();

  return {
    attributes: finalAttrs,
    bio: bioText || 'No description available.',
    rawDescription: rawDesc,
  };
}

/**
 * Dynamic Deduplication Engine
 * Enforces unique ID normalization across state mappers and prevents duplicate cards
 */
export function deduplicateMediaItems(items: MediaItem[]): MediaItem[] {
  if (!Array.isArray(items)) return [];
  const map = new Map<string, MediaItem>();
  for (const item of items) {
    if (item && item.id) {
      const idStr = String(item.id).trim();
      if (!map.has(idStr)) {
        map.set(idStr, item);
      }
    }
  }
  return Array.from(map.values());
}

// Helper to format relation types in clean Title Case (not all uppercase)
function formatRelationType(rel?: string): string {
  if (!rel) return 'Related';
  const clean = rel.replace(/_/g, ' ').toLowerCase();
  return clean.replace(/\b\w/g, (c) => c.toUpperCase());
}

// Map AniList Media object to MediaItem
function mapAniListToMediaItem(media: any, categoryOverride?: MediaCategory): MediaItem {
  let category: MediaCategory = categoryOverride || 'anime';
  if (!categoryOverride) {
    if (media.type === 'MANGA') {
      category = media.format === 'NOVEL' ? 'novel' : 'manga';
    } else {
      category = 'anime';
    }
  }

  const titleEnglish = media.title?.english || media.title?.romaji || media.title?.userPreferred || 'Untitled';
  const titleRomaji = media.title?.romaji || media.title?.native || titleEnglish;
  const titleNative = media.title?.native;

  // Characters: Main Characters first, then Supporting Characters
  const characters: Character[] = (media.characters?.edges || [])
    .filter((edge: any) => edge.node)
    .sort((a: any, b: any) => {
      const aIsMain = a.role === 'MAIN' ? 0 : 1;
      const bIsMain = b.role === 'MAIN' ? 0 : 1;
      return aIsMain - bIsMain;
    })
    .map((edge: any) => {
      const node = edge.node;
      const voiceActorNode = edge.voiceActors?.[0];
      const bday = node.dateOfBirth?.month && node.dateOfBirth?.day
        ? `${node.dateOfBirth.month}/${node.dateOfBirth.day}`
        : undefined;
      const parsed = parseCharacterDescription(node.description, {
        gender: node.gender,
        birthday: bday,
        age: node.age,
        bloodType: node.bloodType,
      });

      return {
        id: String(node.id),
        name: node.name?.full || node.name?.userPreferred || 'Unknown Character',
        nativeName: node.name?.native,
        image: node.image?.large || node.image?.medium || '',
        role: edge.role === 'MAIN' ? 'Main' : 'Supporting',
        hearts: node.favourites || 80,
        favourites: node.favourites || 0,
        gender: node.gender || 'Unknown',
        age: node.age || 'Unknown',
        birthday: bday,
        bloodType: node.bloodType || 'A',
        attributes: parsed.attributes,
        bio: parsed.bio,
        rawDescription: node.description || '',
        voiceActor: voiceActorNode
          ? {
              name: voiceActorNode.name?.full || voiceActorNode.name?.userPreferred || 'Voice Actor',
              nativeName: voiceActorNode.name?.native,
              image: voiceActorNode.image?.large || voiceActorNode.image?.medium,
              language: voiceActorNode.languageV2 || 'Japanese',
            }
          : undefined,
      };
    });

  // Relations (Clean Title Case labels)
  const relations = (media.relations?.edges || [])
    .filter((edge: any) => edge.node)
    .map((edge: any) => {
      const cover = edge.node.coverImage?.extraLarge || edge.node.coverImage?.large || edge.node.coverImage?.medium || '';
      const banner = edge.node.bannerImage || cover;
      const relYear = edge.node.startDate?.year || edge.node.seasonYear;
      return {
        id: String(edge.node.id),
        title: edge.node.title?.english || edge.node.title?.romaji || edge.node.title?.userPreferred || 'Related Work',
        relationType: formatRelationType(edge.relationType),
        format: edge.node.format || (edge.node.type === 'MANGA' ? 'MANGA' : 'TV'),
        coverImage: optimizeImageUrl(cover),
        bannerImage: optimizeImageUrl(banner),
        image: optimizeImageUrl(cover),
        year: relYear,
        score: edge.node.averageScore ? edge.node.averageScore / 10 : 8.0,
      };
    });

  const hasPrequel = relations.some((r: any) => String(r.relationType).toLowerCase() === 'prequel');
  const hasSequel = relations.some((r: any) => String(r.relationType).toLowerCase() === 'sequel');

  // Recommendations (minimum 10+ fetched from API)
  const recommendations = (media.recommendations?.nodes || [])
    .filter((rec: any) => rec.mediaRecommendation)
    .map((rec: any) => {
      const cover = rec.mediaRecommendation.coverImage?.large || rec.mediaRecommendation.coverImage?.medium || rec.mediaRecommendation.coverImage?.extraLarge || '';
      const recYear = rec.mediaRecommendation.startDate?.year || rec.mediaRecommendation.seasonYear;
      return {
        id: String(rec.mediaRecommendation.id),
        title: rec.mediaRecommendation.title?.english || rec.mediaRecommendation.title?.romaji || rec.mediaRecommendation.title?.userPreferred || 'Recommendation',
        coverImage: optimizeImageUrl(cover),
        image: optimizeImageUrl(cover),
        year: recYear,
        score: rec.mediaRecommendation.averageScore ? rec.mediaRecommendation.averageScore / 10 : 8.0,
        userVotes: rec.rating || 10,
      };
    });

  const studios = (media.studios?.nodes || []).map((s: any) => s.name);
  const staffEdges = media.staff?.edges || [];
  const staffNames = staffEdges.map((e: any) => ({
    name: e.node?.name?.full || e.node?.name?.userPreferred || '',
    role: e.role || '',
  }));
  const storyAuthor =
    staffNames.find((s: any) => /story|original creator|author|art|manga|writer|mangaka/i.test(s.role))?.name ||
    staffNames[0]?.name ||
    media.staff?.nodes?.[0]?.name?.full ||
    media.staff?.nodes?.[0]?.name?.userPreferred;

  const rawScore = media.averageScore || media.meanScore || 80;
  const ratingOutOf10 = Number((rawScore / 10).toFixed(1));

  const releaseYear = media.startDate?.year || media.seasonYear || new Date().getFullYear();
  let formatVal: 'TV' | 'Movie' | 'ONA' | 'OVA' | 'Special' | 'Manga' | 'Novel' | 'Light Novel' = 'TV';
  if (category === 'novel' || media.format === 'NOVEL') formatVal = 'Novel';
  else if (category === 'manga' || media.format === 'MANGA' || media.format === 'ONE_SHOT') formatVal = 'Manga';
  else if (media.format === 'MOVIE') formatVal = 'Movie';
  else if (media.format === 'ONA') formatVal = 'ONA';
  else if (media.format === 'OVA') formatVal = 'OVA';
  else if (media.format === 'SPECIAL') formatVal = 'Special';

  let statusVal: 'Releasing' | 'Finished' | 'Upcoming' | 'Not Yet Released' = 'Finished';
  if (media.status === 'RELEASING') statusVal = 'Releasing';
  else if (media.status === 'NOT_YET_RELEASED') statusVal = 'Upcoming';
  else if (media.status === 'FINISHED') statusVal = 'Finished';

  // Extract upcoming countdown / next air time if available
  let nextAiringEpisode: number | undefined;
  let nextAiringTimeStr: string | undefined;
  if (media.nextAiringEpisode) {
    nextAiringEpisode = media.nextAiringEpisode.episode;
    const airDate = new Date(media.nextAiringEpisode.airingAt * 1000);
    nextAiringTimeStr = airDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  let seasonVal: 'Winter' | 'Spring' | 'Summer' | 'Fall' | undefined;
  if (media.season === 'WINTER') seasonVal = 'Winter';
  else if (media.season === 'SPRING') seasonVal = 'Spring';
  else if (media.season === 'SUMMER') seasonVal = 'Summer';
  else if (media.season === 'FALL') seasonVal = 'Fall';

  return {
    id: String(media.id),
    title: titleEnglish,
    romajiTitle: titleRomaji,
    nativeTitle: titleNative,
    coverImage: optimizeImageUrl(media.coverImage?.extraLarge || media.coverImage?.large || media.coverImage?.medium || ''),
    bannerImage: optimizeImageUrl(media.bannerImage || media.coverImage?.extraLarge || media.coverImage?.large),
    category,
    format: formatVal,
    status: statusVal,
    score: ratingOutOf10,
    year: releaseYear,
    season: seasonVal,
    seasonYear: media.seasonYear || releaseYear,
    genres: media.genres || ['Action', 'Fantasy'],
    description: cleanDescription(media.description),
    studio: studios[0] || undefined,
    author: storyAuthor || undefined,
    totalEpisodes: media.episodes,
    totalChapters: media.chapters || undefined,
    totalVolumes: media.volumes || undefined,
    latestEpisode: nextAiringEpisode ? (nextAiringEpisode > 1 ? nextAiringEpisode - 1 : 1) : (media.episodes || undefined),
    currentEpisodeBadge: category === 'manga'
      ? (media.chapters ? `CH ${media.chapters}` : undefined)
      : (nextAiringEpisode || media.episodes) ? `EP ${nextAiringEpisode ? (nextAiringEpisode > 1 ? nextAiringEpisode - 1 : 1) : (media.episodes || 1)}` : undefined,
    nextEpisodeCountdown: media.nextAiringEpisode?.timeUntilAiring ? `${Math.ceil(media.nextAiringEpisode.timeUntilAiring / 86400)}d` : undefined,
    airingAt: media.nextAiringEpisode?.airingAt,
    nextAiringEpisode: media.nextAiringEpisode
      ? {
          episode: media.nextAiringEpisode.episode,
          airingAt: media.nextAiringEpisode.airingAt,
          airingTime: nextAiringTimeStr || '',
          timeUntilAiring: media.nextAiringEpisode.timeUntilAiring,
        }
      : undefined,
    communityHearts: media.favourites || 0,
    idMal: media.idMal || undefined,
    synonyms: Array.isArray(media.synonyms) ? media.synonyms : [],
    characters,
    relations,
    recommendations,
    hasPrequel,
    hasSequel,
  };
}

const MEDIA_FIELDS = `
  id
  idMal
  title {
    romaji
    english
    native
    userPreferred
  }
  synonyms
  coverImage {
    extraLarge
    large
    medium
    color
  }
  bannerImage
  format
  type
  status
  episodes
  chapters
  volumes
  duration
  genres
  tags {
    name
  }
  averageScore
  meanScore
  popularity
  favourites
  trending
  startDate {
    year
    month
    day
  }
  season
  seasonYear
  description(asHtml: false)
  nextAiringEpisode {
    episode
    airingAt
    timeUntilAiring
  }
  studios(isMain: true) {
    nodes {
      name
    }
  }
  staff(sort: [RELEVANCE, FAVOURITES_DESC], perPage: 4) {
    edges {
      role
      node {
        id
        name {
          full
          native
          userPreferred
        }
      }
    }
  }
  characters(sort: [ROLE, RELEVANCE, FAVOURITES_DESC], perPage: 50) {
    edges {
      role
      node {
        id
        name {
          full
          native
          userPreferred
        }
        image {
          large
          medium
        }
        gender
        age
        bloodType
        dateOfBirth {
          year
          month
          day
        }
        favourites
        description
      }
      voiceActors(language: JAPANESE, sort: FAVOURITES_DESC) {
        id
        name {
          full
          native
          userPreferred
        }
        image {
          large
          medium
        }
        languageV2
      }
    }
  }
  relations {
    edges {
      relationType
      node {
        id
        type
        title {
          romaji
          english
          userPreferred
        }
        format
        bannerImage
        coverImage {
          large
          medium
          extraLarge
        }
        startDate {
          year
        }
        seasonYear
        averageScore
      }
    }
  }
  recommendations(sort: RATING_DESC, perPage: 25) {
    nodes {
      rating
      mediaRecommendation {
        id
        title {
          romaji
          english
          userPreferred
        }
        format
        coverImage {
          large
          medium
          extraLarge
        }
        startDate {
          year
        }
        seasonYear
        averageScore
      }
    }
  }
`;

// Helper to calculate human readable time ago for recently aired episodes
export function formatTimeAgo(unixSeconds: number): string {
  const diffSec = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (diffSec < 60) return 'Just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  return `${Math.floor(diffDays / 7)}w ago`;
}

// -------------------------------------------------------------
// 1. ANIME API CALLS
// -------------------------------------------------------------

// Hero Carousel - Trending Anime
export async function fetchTrendingAnime(perPage = 15): Promise<MediaItem[]> {
  const query = `
    query GetTrendingAnime($perPage: Int) {
      Page(page: 1, perPage: $perPage) {
        media(type: ANIME, sort: TRENDING_DESC) {
          ${MEDIA_FIELDS}
        }
      }
    }
  `;
  const data = await fetchFromAniList<any>(query, { perPage: Math.max(perPage, 15) });
  const items = (data?.Page?.media || []).map((m: any) => mapAniListToMediaItem(m, 'anime'));
  return deduplicateMediaItems(items);
}

// Section 1: Popular This Season (Expanded Real Items - Only Currently Airing & Released Seasonal Anime)
export async function fetchPopularThisSeason(perPage = 30): Promise<MediaItem[]> {
  const now = new Date();
  const month = now.getMonth() + 1;
  let season = 'WINTER';
  if (month >= 4 && month <= 6) season = 'SPRING';
  else if (month >= 7 && month <= 9) season = 'SUMMER';
  else if (month >= 10 && month <= 12) season = 'FALL';

  const year = now.getFullYear();

  const query = `
    query GetSeasonalAnime($season: MediaSeason, $seasonYear: Int, $perPage: Int) {
      Page(page: 1, perPage: $perPage) {
        media(type: ANIME, season: $season, seasonYear: $seasonYear, status_not: NOT_YET_RELEASED, sort: POPULARITY_DESC) {
          ${MEDIA_FIELDS}
        }
      }
    }
  `;

  try {
    const data = await fetchFromAniList<any>(query, { season, seasonYear: year, perPage: Math.max(perPage, 30) });
    const rawList = data?.Page?.media || [];
    const items = rawList
      .map((m: any) => mapAniListToMediaItem(m, 'anime'))
      .filter((item: MediaItem) => item.status !== 'Not Yet Released');

    return deduplicateMediaItems(items);
  } catch (err) {
    console.warn('Failed to fetch popular this season anime:', err);
    return [];
  }
}

// Section 2: Recently Released Episodes (AniList Airing Schedule with TIME_DESC -> Newest Released First, Older Released Pushed Back)
export async function fetchRecentlyReleasedEpisodes(perPage = 50): Promise<MediaItem[]> {
  const nowUnix = Math.floor(Date.now() / 1000);
  const twoWeeksAgoUnix = nowUnix - 14 * 86400; // Past 14 days of releases

  const query = `
    query GetRecentlyReleasedEpisodes($airingAt_greater: Int, $airingAt_lesser: Int, $perPage: Int) {
      Page(page: 1, perPage: $perPage) {
        airingSchedules(airingAt_greater: $airingAt_greater, airingAt_lesser: $airingAt_lesser, sort: TIME_DESC) {
          id
          airingAt
          episode
          timeUntilAiring
          media {
            ${MEDIA_FIELDS}
          }
        }
      }
    }
  `;

  try {
    const data = await fetchFromAniList<any>(query, {
      airingAt_greater: twoWeeksAgoUnix,
      airingAt_lesser: nowUnix,
      perPage: Math.max(perPage, 50),
    });

    const schedules = data?.Page?.airingSchedules || [];
    if (schedules.length > 0) {
      const items: MediaItem[] = [];
      const seenMediaIds = new Set<string>();

      for (const s of schedules) {
        if (!s.media) continue;
        const mediaIdStr = String(s.media.id);
        if (seenMediaIds.has(mediaIdStr)) continue;
        seenMediaIds.add(mediaIdStr);

        const mediaItem = mapAniListToMediaItem(s.media, 'anime');
        mediaItem.latestEpisode = s.episode;
        mediaItem.currentEpisodeBadge = `EP ${s.episode}`;
        mediaItem.airingAt = s.airingAt;
        mediaItem.isReleased = true;
        mediaItem.releasedTimeAgo = formatTimeAgo(s.airingAt);

        items.push(mediaItem);
      }

      return items;
    }
  } catch (err) {
    console.warn('Failed to fetch recently released schedules from AniList:', err);
  }

  return [];
}

// Section 2: New Episodes (Strict Exception Rule: ONLY actively airing titles with recent broadcasts)
export async function fetchNewEpisodes(perPage = 40): Promise<MediaItem[]> {
  return fetchRecentlyReleasedEpisodes(perPage);
}

// Section 3: Community Loved (Highest Favourites / Top Rated)
export async function fetchCommunityLovedAnime(perPage = 30): Promise<MediaItem[]> {
  const query = `
    query GetCommunityLovedAnime($perPage: Int) {
      Page(page: 1, perPage: $perPage) {
        media(type: ANIME, sort: FAVOURITES_DESC) {
          ${MEDIA_FIELDS}
        }
      }
    }
  `;
  const data = await fetchFromAniList<any>(query, { perPage: Math.max(perPage, 30) });
  const items = (data?.Page?.media || []).map((m: any) => mapAniListToMediaItem(m, 'anime'));
  return deduplicateMediaItems(items);
}

// Section 4: Recently Completed
export async function fetchRecentlyCompletedAnime(perPage = 30): Promise<MediaItem[]> {
  const query = `
    query GetRecentlyCompletedAnime($perPage: Int) {
      Page(page: 1, perPage: $perPage) {
        media(type: ANIME, status: FINISHED, sort: [END_DATE_DESC, POPULARITY_DESC]) {
          ${MEDIA_FIELDS}
        }
      }
    }
  `;
  const data = await fetchFromAniList<any>(query, { perPage: Math.max(perPage, 30) });
  const rawList = data?.Page?.media || [];
  const items = rawList
    .map((m: any) => mapAniListToMediaItem(m, 'anime'))
    .filter((item: MediaItem) => item.status === 'Finished' && item.category === 'anime');
  return deduplicateMediaItems(items);
}

// Section 5: Anime Movies
export async function fetchAnimeMovies(perPage = 30): Promise<MediaItem[]> {
  const query = `
    query GetAnimeMovies($perPage: Int) {
      Page(page: 1, perPage: $perPage) {
        media(type: ANIME, format: MOVIE, sort: POPULARITY_DESC) {
          ${MEDIA_FIELDS}
        }
      }
    }
  `;
  const data = await fetchFromAniList<any>(query, { perPage: Math.max(perPage, 30) });
  const items = (data?.Page?.media || []).map((m: any) => mapAniListToMediaItem(m, 'anime'));
  return deduplicateMediaItems(items);
}

// Section 6: Upcoming Anime
export async function fetchUpcomingAnime(perPage = 60, format?: string): Promise<MediaItem[]> {
  let formatArg = '';
  if (format && format !== 'All') {
    if (format === 'TV') formatArg = ', format_in: [TV, TV_SHORT]';
    else if (format === 'Movie') formatArg = ', format: MOVIE';
    else if (format === 'Special') formatArg = ', format_in: [SPECIAL, OVA, ONA]';
    else if (format === 'OVA' || format === 'ONA') formatArg = ', format_in: [OVA, ONA]';
  }

  const query = `
    query GetUpcomingAnime($perPage: Int) {
      Page(page: 1, perPage: $perPage) {
        media(type: ANIME, status: NOT_YET_RELEASED${formatArg}, sort: POPULARITY_DESC) {
          ${MEDIA_FIELDS}
        }
      }
    }
  `;
  try {
    const data = await fetchFromAniList<any>(query, { perPage: Math.max(perPage, 60) });
    const rawList = data?.Page?.media || [];
    let items = rawList.map((m: any) => mapAniListToMediaItem(m, 'anime'));

    // Client-side strict filter guarantee
    if (format && format !== 'All') {
      items = items.filter((item: MediaItem) => {
        const fmt = String(item.format || '').toUpperCase();
        if (format === 'TV') return fmt === 'TV' || fmt === 'TV_SHORT';
        if (format === 'Movie') return fmt === 'MOVIE';
        if (format === 'Special') return ['SPECIAL', 'OVA', 'ONA', 'MUSIC'].includes(fmt);
        if (format === 'OVA' || format === 'ONA') return fmt === 'OVA' || fmt === 'ONA';
        return true;
      });
    }

    return deduplicateMediaItems(items);
  } catch (err) {
    console.warn('Failed to fetch upcoming anime from AniList:', err);
    return [];
  }
}

// -------------------------------------------------------------
// 2. MANGA API CALLS (AniList & MangaDex)
// -------------------------------------------------------------

// Hero Carousel - Trending Manga
export async function fetchTrendingManga(perPage = 15): Promise<MediaItem[]> {
  const query = `
    query GetTrendingManga($perPage: Int) {
      Page(page: 1, perPage: $perPage) {
        media(type: MANGA, format: MANGA, sort: TRENDING_DESC) {
          ${MEDIA_FIELDS}
        }
      }
    }
  `;
  const data = await fetchFromAniList<any>(query, { perPage: Math.max(perPage, 15) });
  const items = (data?.Page?.media || []).map((m: any) => mapAniListToMediaItem(m, 'manga'));
  return deduplicateMediaItems(items);
}

// Manga Section 2: Popular Manga (Expanded)
export async function fetchPopularManga(perPage = 30): Promise<MediaItem[]> {
  const query = `
    query GetPopularManga($perPage: Int) {
      Page(page: 1, perPage: $perPage) {
        media(type: MANGA, format: MANGA, sort: POPULARITY_DESC) {
          ${MEDIA_FIELDS}
        }
      }
    }
  `;
  const data = await fetchFromAniList<any>(query, { perPage: Math.max(perPage, 30) });
  const items = (data?.Page?.media || []).map((m: any) => mapAniListToMediaItem(m, 'manga'));
  return deduplicateMediaItems(items);
}

// Manga Section 3: Recently Updated Manga (Strict Exception Rule: ONLY authentic actively releasing scanlation updates)
export async function fetchRecentlyUpdatedManga(perPage = 40): Promise<MediaItem[]> {
  const query = `
    query GetRecentlyUpdatedManga($perPage: Int) {
      Page(page: 1, perPage: $perPage) {
        media(type: MANGA, format_in: [MANGA, ONE_SHOT], status: RELEASING, sort: [UPDATED_AT_DESC, POPULARITY_DESC]) {
          ${MEDIA_FIELDS}
        }
      }
    }
  `;
  const data = await fetchFromAniList<any>(query, { perPage: Math.max(perPage, 40) });
  const rawList = data?.Page?.media || [];
  const items = rawList
    .map((m: any) => mapAniListToMediaItem(m, 'manga'))
    .filter((item: MediaItem) => item.status === 'Releasing' && item.category === 'manga');
  return deduplicateMediaItems(items);
}

// Manga Section 4: Community Loved Manga
export async function fetchCommunityLovedManga(perPage = 30): Promise<MediaItem[]> {
  const query = `
    query GetCommunityLovedManga($perPage: Int) {
      Page(page: 1, perPage: $perPage) {
        media(type: MANGA, format: MANGA, sort: FAVOURITES_DESC) {
          ${MEDIA_FIELDS}
        }
      }
    }
  `;
  const data = await fetchFromAniList<any>(query, { perPage: Math.max(perPage, 30) });
  const items = (data?.Page?.media || []).map((m: any) => mapAniListToMediaItem(m, 'manga'));
  return deduplicateMediaItems(items);
}

// Manga Section 5: Recently Completed Manga
export async function fetchRecentlyCompletedManga(perPage = 30): Promise<MediaItem[]> {
  const query = `
    query GetRecentlyCompletedManga($perPage: Int) {
      Page(page: 1, perPage: $perPage) {
        media(type: MANGA, format: MANGA, status: FINISHED, sort: [END_DATE_DESC, POPULARITY_DESC]) {
          ${MEDIA_FIELDS}
        }
      }
    }
  `;
  const data = await fetchFromAniList<any>(query, { perPage: Math.max(perPage, 30) });
  const rawList = data?.Page?.media || [];
  const items = rawList
    .map((m: any) => mapAniListToMediaItem(m, 'manga'))
    .filter((item: MediaItem) => item.status === 'Finished' && item.category === 'manga');
  return deduplicateMediaItems(items);
}

// -------------------------------------------------------------
// 3. LIGHT NOVEL API CALLS (AniList Format: NOVEL)
// -------------------------------------------------------------

// Hero Carousel - Trending Novels
export async function fetchTrendingNovels(perPage = 15): Promise<MediaItem[]> {
  const query = `
    query GetTrendingNovels($perPage: Int) {
      Page(page: 1, perPage: $perPage) {
        media(type: MANGA, format: NOVEL, sort: TRENDING_DESC) {
          ${MEDIA_FIELDS}
        }
      }
    }
  `;
  const data = await fetchFromAniList<any>(query, { perPage: Math.max(perPage, 15) });
  const items = (data?.Page?.media || []).map((m: any) => mapAniListToMediaItem(m, 'novel'));
  return deduplicateMediaItems(items);
}

// Novel Section 1: Seasonal / Trending Light Novels
export async function fetchSeasonalNovels(perPage = 30): Promise<MediaItem[]> {
  const query = `
    query GetSeasonalNovels($perPage: Int) {
      Page(page: 1, perPage: $perPage) {
        media(type: MANGA, format: NOVEL, sort: [TRENDING_DESC, POPULARITY_DESC]) {
          ${MEDIA_FIELDS}
        }
      }
    }
  `;
  const data = await fetchFromAniList<any>(query, { perPage: Math.max(perPage, 30) });
  const items = (data?.Page?.media || []).map((m: any) => mapAniListToMediaItem(m, 'novel'));
  return deduplicateMediaItems(items);
}

// Novel Section 2: Popular Light Novels (Strict Rule: Real released novel chapters/volumes)
export async function fetchPopularNovels(perPage = 30): Promise<MediaItem[]> {
  const query = `
    query GetPopularNovels($perPage: Int) {
      Page(page: 1, perPage: $perPage) {
        media(type: MANGA, format: NOVEL, sort: POPULARITY_DESC) {
          ${MEDIA_FIELDS}
        }
      }
    }
  `;
  const data = await fetchFromAniList<any>(query, { perPage: Math.max(perPage, 30) });
  const rawList = data?.Page?.media || [];
  const items = rawList
    .map((m: any) => mapAniListToMediaItem(m, 'novel'))
    .filter((item: MediaItem) => item.category === 'novel');
  return deduplicateMediaItems(items);
}

// Novel Section 3: Monster / Isekai / Action Novels
export async function fetchMonsterNovels(perPage = 30): Promise<MediaItem[]> {
  const query = `
    query GetMonsterNovels($perPage: Int) {
      Page(page: 1, perPage: $perPage) {
        media(type: MANGA, format: NOVEL, genre: "Fantasy", sort: POPULARITY_DESC) {
          ${MEDIA_FIELDS}
        }
      }
    }
  `;
  const data = await fetchFromAniList<any>(query, { perPage: Math.max(perPage, 30) });
  const items = (data?.Page?.media || []).map((m: any) => mapAniListToMediaItem(m, 'novel'));
  return deduplicateMediaItems(items);
}

// Novel Section 4: Princess / Romance / Villainess Novels
export async function fetchPrincessNovels(perPage = 30): Promise<MediaItem[]> {
  const query = `
    query GetPrincessNovels($perPage: Int) {
      Page(page: 1, perPage: $perPage) {
        media(type: MANGA, format: NOVEL, genre: "Romance", sort: POPULARITY_DESC) {
          ${MEDIA_FIELDS}
        }
      }
    }
  `;
  const data = await fetchFromAniList<any>(query, { perPage: Math.max(perPage, 30) });
  const items = (data?.Page?.media || []).map((m: any) => mapAniListToMediaItem(m, 'novel'));
  return deduplicateMediaItems(items);
}

// Novel Section 5: Magic / Supernatural Novels
export async function fetchMagicNovels(perPage = 30): Promise<MediaItem[]> {
  const query = `
    query GetMagicNovels($perPage: Int) {
      Page(page: 1, perPage: $perPage) {
        media(type: MANGA, format: NOVEL, genre_in: ["Magic", "Supernatural", "Adventure"], sort: POPULARITY_DESC) {
          ${MEDIA_FIELDS}
        }
      }
    }
  `;
  const data = await fetchFromAniList<any>(query, { perPage: Math.max(perPage, 30) });
  const items = (data?.Page?.media || []).map((m: any) => mapAniListToMediaItem(m, 'novel'));
  return deduplicateMediaItems(items);
}

// -------------------------------------------------------------
// 4. AIRING SCHEDULE API (AniList AiringSchedule Query)
// -------------------------------------------------------------

export async function fetchAiringScheduleWeek(): Promise<ScheduleDay[]> {
  const now = new Date();
  // Find Monday of the current week (start from 00:00:00 local time)
  const dayOfWeek = (now.getDay() + 6) % 7; // 0 = Monday, 6 = Sunday
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOfWeek, 0, 0, 0, 0);

  const startTimestamp = Math.floor(monday.getTime() / 1000);
  const endTimestamp = startTimestamp + 7 * 86400; // 7 full days

  const query = `
    query GetWeeklySchedule($airingAt_greater: Int, $airingAt_lesser: Int, $page: Int) {
      Page(page: $page, perPage: 50) {
        pageInfo {
          hasNextPage
        }
        airingSchedules(airingAt_greater: $airingAt_greater, airingAt_lesser: $airingAt_lesser, sort: TIME) {
          id
          airingAt
          episode
          timeUntilAiring
          media {
            ${MEDIA_FIELDS}
          }
        }
      }
    }
  `;

  try {
    // Fetch multiple pages in parallel to cover the entire week (up to 200 airings)
    const pageRequests = [1, 2, 3, 4].map((page) =>
      fetchFromAniList<any>(query, {
        page,
        airingAt_greater: startTimestamp,
        airingAt_lesser: endTimestamp,
      }).catch(() => null)
    );

    const pageResults = await Promise.all(pageRequests);
    const rawSchedules: any[] = [];
    const seenScheduleIds = new Set<number>();

    for (const res of pageResults) {
      if (res?.Page?.airingSchedules) {
        for (const s of res.Page.airingSchedules) {
          if (s && s.id && !seenScheduleIds.has(s.id)) {
            seenScheduleIds.add(s.id);
            rawSchedules.push(s);
          }
        }
      }
    }

    const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const dayNamesShort: ('Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun')[] = [
      'Mon',
      'Tue',
      'Wed',
      'Thu',
      'Fri',
      'Sat',
      'Sun',
    ];

    const weekDays: ScheduleDay[] = dayNames.map((dayName, idx) => {
      const dayDate = new Date(monday.getTime() + idx * 86400 * 1000);
      const isToday =
        dayDate.getDate() === now.getDate() &&
        dayDate.getMonth() === now.getMonth() &&
        dayDate.getFullYear() === now.getFullYear();

      const dateString = dayDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const dayNameShort = dayNamesShort[idx];
      const dateNum = dayDate.getDate();
      const dayStartUnix = Math.floor(dayDate.getTime() / 1000);
      const dayEndUnix = dayStartUnix + 86400;

      // Filter and sort schedules for this day
      const dayItems = rawSchedules
        .filter((s: any) => s.airingAt >= dayStartUnix && s.airingAt < dayEndUnix && s.media)
        .sort((a: any, b: any) => a.airingAt - b.airingAt)
        .map((s: any) => {
          const mediaItem = mapAniListToMediaItem(s.media, 'anime');
          const airDate = new Date(s.airingAt * 1000);
          const timeFormatted = airDate.toLocaleTimeString([], {
            hour: 'numeric',
            minute: '2-digit',
            hour12: true,
          });

          const isPast = s.airingAt <= Math.floor(Date.now() / 1000);
          const timeAgoStr = isPast ? formatTimeAgo(s.airingAt) : undefined;

          mediaItem.latestEpisode = s.episode;
          mediaItem.currentEpisodeBadge = `EP ${s.episode}`;
          mediaItem.airingAt = s.airingAt;
          mediaItem.isReleased = isPast;
          mediaItem.releasedTimeAgo = timeAgoStr;

          return {
            id: `sched_${s.id}`,
            media: mediaItem,
            airingTime: timeFormatted,
            airingAt: s.airingAt,
            episodeNumber: s.episode,
            isAiringToday: isToday,
            isReleased: isPast,
            releasedTimeAgo: timeAgoStr,
          };
        });

      return {
        day: dayName,
        dayName: dayNameShort,
        date: dateString,
        dateNumber: dateNum,
        isToday,
        items: dayItems,
      };
    });

    return weekDays;
  } catch (err) {
    console.warn('Error fetching weekly schedule from AniList:', err);
    return [];
  }
}

// -------------------------------------------------------------
// 5. LIVE SEARCH & FILTER API (AniList & MangaDex)
// -------------------------------------------------------------

export async function searchAniList(
  searchQuery: string,
  filters: Partial<FilterOptions> = {},
  page = 1,
  perPage = 24
): Promise<{ items: MediaItem[]; hasNextPage: boolean; total: number }> {
  let type: 'ANIME' | 'MANGA' = 'ANIME';
  let format_in: string[] | undefined = undefined;

  if (filters.category === 'manga') {
    type = 'MANGA';
    if (filters.format && filters.format.length > 0) {
      const mapped = filters.format.map((f) => {
        if (f.toLowerCase() === 'manga') return 'MANGA';
        if (f.toLowerCase().includes('one')) return 'ONE_SHOT';
        return f.toUpperCase().replace(/\s+/g, '_');
      });
      format_in = mapped.filter((f) => ['MANGA', 'ONE_SHOT'].includes(f));
      if (format_in.length === 0) format_in = ['MANGA', 'ONE_SHOT'];
    } else {
      format_in = ['MANGA', 'ONE_SHOT'];
    }
  } else if (filters.category === 'novel') {
    type = 'MANGA';
    format_in = ['NOVEL'];
  } else {
    type = 'ANIME';
    if (filters.format && filters.format.length > 0) {
      const mapped = filters.format.flatMap((f) => {
        const upper = f.toUpperCase().replace(/\s+/g, '_');
        if (upper === 'TV') return ['TV', 'TV_SHORT'];
        if (upper === 'MOVIE') return ['MOVIE'];
        if (upper === 'SPECIAL') return ['SPECIAL'];
        if (upper === 'OVA') return ['OVA'];
        if (upper === 'ONA') return ['ONA'];
        return [upper];
      });
      format_in = mapped;
    }
  }

  let status_in: string[] | undefined = undefined;
  if (filters.status && filters.status.length > 0) {
    status_in = filters.status.map((st) => {
      if (st.toLowerCase().includes('releasing')) return 'RELEASING';
      if (st.toLowerCase().includes('finished')) return 'FINISHED';
      if (st.toLowerCase().includes('upcoming') || st.toLowerCase().includes('not yet')) return 'NOT_YET_RELEASED';
      if (st.toLowerCase().includes('cancel')) return 'CANCELLED';
      if (st.toLowerCase().includes('hiatus')) return 'HIATUS';
      return 'RELEASING';
    });
  }

  let genre_in: string[] | undefined = undefined;
  if (filters.genres && filters.genres.length > 0) {
    genre_in = filters.genres;
  }

  let tag_in: string[] | undefined = undefined;
  if (filters.advancedTags && filters.advancedTags.length > 0) {
    tag_in = filters.advancedTags;
  }

  let averageScore_greater: number | undefined = undefined;
  if (filters.minScore && filters.minScore !== 'Any') {
    const parsed = parseInt(filters.minScore, 10);
    if (!isNaN(parsed)) {
      averageScore_greater = parsed * 10;
    }
  }
  if (filters.scoreRange && filters.scoreRange[0] > 0) {
    averageScore_greater = Math.max(averageScore_greater || 0, filters.scoreRange[0]);
  }

  let seasonYear: number | undefined = undefined;
  let startDate_greater: number | undefined = undefined;
  let startDate_lesser: number | undefined = undefined;

  if (filters.selectedYear && filters.selectedYear !== 'Any') {
    const yr = parseInt(filters.selectedYear, 10);
    if (!isNaN(yr)) {
      seasonYear = yr;
    }
  } else if (filters.yearRange && (filters.yearRange[0] > 1940 || filters.yearRange[1] < 2028)) {
    startDate_greater = filters.yearRange[0] * 10000;
    startDate_lesser = filters.yearRange[1] * 10000 + 1231;
  }

  let season: string | undefined = undefined;
  if (filters.season && filters.season.length > 0) {
    const validSeasons = filters.season.filter((s) => s !== 'Any');
    if (validSeasons.length > 0) {
      season = validSeasons[0].toUpperCase();
    }
  }

  const variables: Record<string, any> = {
    page,
    perPage,
    type,
    sort: (searchQuery.trim() || filters.studio?.trim()) ? ['SEARCH_MATCH', 'POPULARITY_DESC'] : ['SCORE_DESC', 'POPULARITY_DESC'],
  };

  if (searchQuery.trim()) {
    variables.search = searchQuery.trim();
  } else if (filters.studio && filters.studio.trim()) {
    variables.search = filters.studio.trim();
  }
  if (format_in && format_in.length > 0) variables.format_in = format_in;
  if (status_in && status_in.length > 0) variables.status_in = status_in;
  if (genre_in && genre_in.length > 0) variables.genre_in = genre_in;
  if (tag_in && tag_in.length > 0) variables.tag_in = tag_in;
  if (averageScore_greater !== undefined) variables.averageScore_greater = averageScore_greater;
  if (seasonYear !== undefined) variables.seasonYear = seasonYear;
  if (startDate_greater !== undefined) variables.startDate_greater = startDate_greater;
  if (startDate_lesser !== undefined) variables.startDate_lesser = startDate_lesser;
  if (season !== undefined) variables.season = season;

  const query = `
    query SearchMedia(
      $page: Int,
      $perPage: Int,
      $search: String,
      $type: MediaType,
      $format_in: [MediaFormat],
      $status_in: [MediaStatus],
      $genre_in: [String],
      $tag_in: [String],
      $season: MediaSeason,
      $seasonYear: Int,
      $startDate_greater: FuzzyDateInt,
      $startDate_lesser: FuzzyDateInt,
      $averageScore_greater: Int,
      $sort: [MediaSort]
    ) {
      Page(page: $page, perPage: $perPage) {
        pageInfo {
          total
          hasNextPage
        }
        media(
          search: $search,
          type: $type,
          format_in: $format_in,
          status_in: $status_in,
          genre_in: $genre_in,
          tag_in: $tag_in,
          season: $season,
          seasonYear: $seasonYear,
          startDate_greater: $startDate_greater,
          startDate_lesser: $startDate_lesser,
          averageScore_greater: $averageScore_greater,
          sort: $sort
        ) {
          ${MEDIA_FIELDS}
        }
      }
    }
  `;

  try {
    const data = await fetchFromAniList<any>(query, variables);
    const mediaList = data?.Page?.media || [];
    const pageInfo = data?.Page?.pageInfo || { total: mediaList.length, hasNextPage: false };

    let items = mediaList.map((m: any) => mapAniListToMediaItem(m, filters.category));

    // Refine studio / author filter client-side if provided
    if (filters.studio && filters.studio.trim()) {
      const studioQuery = filters.studio.trim().toLowerCase();
      const matched = items.filter((item: MediaItem) =>
        item.studio?.toLowerCase().includes(studioQuery) ||
        item.author?.toLowerCase().includes(studioQuery)
      );
      if (matched.length > 0) {
        items = matched;
      }
    }

    const uniqueItems = deduplicateMediaItems(items);

    return {
      items: uniqueItems,
      hasNextPage: pageInfo.hasNextPage || false,
      total: pageInfo.total || uniqueItems.length,
    };
  } catch (err) {
    console.warn('Search error from AniList:', err);
    return { items: [], hasNextPage: false, total: 0 };
  }
}

// -------------------------------------------------------------
// 6. SINGLE MEDIA DETAILS BY ID
// -------------------------------------------------------------

async function fetchMediaDetailsByIdNetwork(id: string | number): Promise<MediaItem | null> {
  const query = `
    query GetMediaById($id: Int) {
      Media(id: $id) {
        ${MEDIA_FIELDS}
      }
    }
  `;
  try {
    const data = await fetchFromAniList<any>(query, { id: Number(id) });
    if (!data?.Media) return null;
    return mapAniListToMediaItem(data.Media);
  } catch (err) {
    console.warn(`Error fetching media by id ${id}:`, err);
    return null;
  }
}

export async function fetchMediaDetailsById(id: string | number): Promise<MediaItem | null> {
  const cacheKey = `media_details_${id}`;

  // 1. Instant Synchronous Cache Hit (0ms)
  const syncHit = swrGetSync<MediaItem>(cacheKey);
  if (syncHit) {
    if (syncHit.isFresh) {
      return syncHit.data;
    }
    // SWR: return stale data immediately, revalidate silently in background
    swrFetchDedupe(cacheKey, async () => {
      const fresh = await fetchMediaDetailsByIdNetwork(id);
      if (fresh) await swrSet(cacheKey, fresh);
      return fresh;
    }).catch(() => {});
    return syncHit.data;
  }

  // 2. Async IndexedDB Cache Hit
  const asyncHit = await swrGet<MediaItem>(cacheKey);
  if (asyncHit) {
    if (!asyncHit.isFresh) {
      swrFetchDedupe(cacheKey, async () => {
        const fresh = await fetchMediaDetailsByIdNetwork(id);
        if (fresh) await swrSet(cacheKey, fresh);
        return fresh;
      }).catch(() => {});
    }
    return asyncHit.data;
  }

  // 3. Network Fetch with in-flight deduplication
  return swrFetchDedupe(cacheKey, async () => {
    const fresh = await fetchMediaDetailsByIdNetwork(id);
    if (fresh) await swrSet(cacheKey, fresh);
    return fresh;
  });
}

// -------------------------------------------------------------
// 6B. REAL ANILIST CHARACTER DETAILS & APPEARANCES PROVIDER
// -------------------------------------------------------------

async function fetchCharacterDetailsByIdNetwork(id: string | number): Promise<Character | null> {
  const numId = Number(id);
  if (!numId || isNaN(numId)) return null;

  const query = `
    query ($id: Int) {
      Character (id: $id) {
        id
        name {
          full
          native
          userPreferred
          alternative
        }
        image {
          large
          medium
        }
        description
        gender
        dateOfBirth {
          year
          month
          day
        }
        age
        bloodType
        favourites
        media(perPage: 50, sort: [POPULARITY_DESC, SCORE_DESC]) {
          edges {
            characterRole
            node {
              id
              type
              format
              title {
                english
                romaji
                userPreferred
              }
              coverImage {
                extraLarge
                large
                medium
              }
              startDate {
                year
              }
            }
          }
        }
      }
    }
  `;

  try {
    const data = await fetchFromAniList<{ Character?: any }>(query, { id: numId });
    const c = data?.Character;
    if (!c) return null;

    const bday = c.dateOfBirth?.month && c.dateOfBirth?.day
      ? `${c.dateOfBirth.month}/${c.dateOfBirth.day}`
      : undefined;

    const parsed = parseCharacterDescription(c.description, {
      gender: c.gender || undefined,
      birthday: bday,
      age: c.age || undefined,
      bloodType: c.bloodType || undefined,
    });

    const seenMediaIds = new Set<string>();
    const appearedInList: {
      id: string | number;
      title: string;
      image: string;
      year: string | number;
      format: string;
      type?: string;
    }[] = [];

    const edges = c.media?.edges || [];
    for (const edge of edges) {
      const node = edge.node;
      if (!node || seenMediaIds.has(String(node.id))) continue;

      // Filter: Only anime-related series (exclude manga, novels, one-shots)
      const rawType = (node.type || '').toUpperCase();
      const rawFmt = (node.format || '').toUpperCase();
      if (rawType === 'MANGA' || rawFmt === 'MANGA' || rawFmt === 'NOVEL' || rawFmt === 'ONE_SHOT') {
        continue;
      }

      seenMediaIds.add(String(node.id));

      const title = node.title?.english || node.title?.romaji || node.title?.userPreferred || 'Untitled';
      const img = node.coverImage?.extraLarge || node.coverImage?.large || node.coverImage?.medium || '';
      const year = node.startDate?.year || '';

      const rawFormat = (node.format || node.type || 'TV').toUpperCase();
      let format = rawFormat;
      if (rawFormat === 'MOVIE') format = 'Movie';
      else if (rawFormat === 'SPECIAL') format = 'Special';
      else if (rawFormat === 'TV') format = 'TV';
      else if (rawFormat === 'OVA') format = 'OVA';
      else if (rawFormat === 'ONA') format = 'ONA';
      else if (rawFormat === 'MANGA') format = 'Manga';
      else if (rawFormat === 'TV_SHORT') format = 'TV Short';

      appearedInList.push({
        id: String(node.id),
        title: title.toUpperCase(),
        image: optimizeImageUrl(img),
        year: year ? String(year) : 'Unknown',
        format,
        type: node.type,
      });
    }

    return {
      id: String(c.id),
      name: c.name?.full || c.name?.userPreferred || 'Unknown Character',
      nativeName: c.name?.native,
      image: optimizeImageUrl(c.image?.large || c.image?.medium || ''),
      role: 'Main',
      hearts: c.favourites || 0,
      favourites: c.favourites || 0,
      gender: c.gender || 'Unknown',
      age: c.age || 'Unknown',
      birthday: bday,
      bloodType: c.bloodType || 'Unknown',
      attributes: parsed.attributes,
      bio: parsed.bio,
      rawDescription: c.description || '',
      appearedIn: appearedInList,
    };
  } catch (err) {
    console.error('Failed to fetch character details from AniList:', err);
    return null;
  }
}

export async function fetchCharacterDetailsById(id: string | number): Promise<Character | null> {
  const cacheKey = `character_details_${id}`;

  const syncHit = swrGetSync<Character>(cacheKey);
  if (syncHit) {
    if (syncHit.isFresh) {
      return syncHit.data;
    }
    swrFetchDedupe(cacheKey, async () => {
      const fresh = await fetchCharacterDetailsByIdNetwork(id);
      if (fresh) await swrSet(cacheKey, fresh);
      return fresh;
    }).catch(() => {});
    return syncHit.data;
  }

  const asyncHit = await swrGet<Character>(cacheKey);
  if (asyncHit) {
    if (!asyncHit.isFresh) {
      swrFetchDedupe(cacheKey, async () => {
        const fresh = await fetchCharacterDetailsByIdNetwork(id);
        if (fresh) await swrSet(cacheKey, fresh);
        return fresh;
      }).catch(() => {});
    }
    return asyncHit.data;
  }

  return swrFetchDedupe(cacheKey, async () => {
    const fresh = await fetchCharacterDetailsByIdNetwork(id);
    if (fresh) await swrSet(cacheKey, fresh);
    return fresh;
  });
}

export async function fetchCharacterDetailsByName(name: string): Promise<Character | null> {
  const cleanName = name.trim();
  if (!cleanName) return null;
  const cacheKey = `character_details_name_${cleanName.toLowerCase()}`;

  const syncHit = swrGetSync<Character>(cacheKey);
  if (syncHit) {
    if (syncHit.isFresh) return syncHit.data;
  }

  const query = `
    query ($search: String) {
      Character (search: $search) {
        id
        name {
          full
          native
          userPreferred
        }
        image {
          large
          medium
        }
        description
        gender
        dateOfBirth {
          year
          month
          day
        }
        age
        bloodType
        favourites
        media(perPage: 50, sort: [POPULARITY_DESC, SCORE_DESC]) {
          edges {
            characterRole
            node {
              id
              type
              format
              title {
                english
                romaji
                userPreferred
              }
              coverImage {
                extraLarge
                large
                medium
              }
              startDate {
                year
              }
            }
          }
        }
      }
    }
  `;

  return swrFetchDedupe(cacheKey, async () => {
    try {
      const data = await fetchFromAniList<{ Character?: any }>(query, { search: cleanName });
      const c = data?.Character;
      if (!c) return null;

      const bday = c.dateOfBirth?.month && c.dateOfBirth?.day
        ? `${c.dateOfBirth.month}/${c.dateOfBirth.day}`
        : undefined;

      const parsed = parseCharacterDescription(c.description, {
        gender: c.gender || undefined,
        birthday: bday,
        age: c.age || undefined,
        bloodType: c.bloodType || undefined,
      });

      const seenMediaIds = new Set<string>();
      const appearedInList: {
        id: string | number;
        title: string;
        image: string;
        year: string | number;
        format: string;
        type?: string;
      }[] = [];

      const edges = c.media?.edges || [];
      for (const edge of edges) {
        const node = edge.node;
        if (!node || seenMediaIds.has(String(node.id))) continue;

        // Filter: Only anime-related series (exclude manga, novels, one-shots)
        const rawType = (node.type || '').toUpperCase();
        const rawFmt = (node.format || '').toUpperCase();
        if (rawType === 'MANGA' || rawFmt === 'MANGA' || rawFmt === 'NOVEL' || rawFmt === 'ONE_SHOT') {
          continue;
        }

        seenMediaIds.add(String(node.id));

        const title = node.title?.english || node.title?.romaji || node.title?.userPreferred || 'Untitled';
        const img = node.coverImage?.extraLarge || node.coverImage?.large || node.coverImage?.medium || '';
        const year = node.startDate?.year || '';

        const rawFormat = (node.format || node.type || 'TV').toUpperCase();
        let format = rawFormat;
        if (rawFormat === 'MOVIE') format = 'Movie';
        else if (rawFormat === 'SPECIAL') format = 'Special';
        else if (rawFormat === 'TV') format = 'TV';
        else if (rawFormat === 'OVA') format = 'OVA';
        else if (rawFormat === 'ONA') format = 'ONA';
        else if (rawFormat === 'MANGA') format = 'Manga';
        else if (rawFormat === 'TV_SHORT') format = 'TV Short';

        appearedInList.push({
          id: String(node.id),
          title: title.toUpperCase(),
          image: optimizeImageUrl(img),
          year: year ? String(year) : 'Unknown',
          format,
          type: node.type,
        });
      }

      const charItem: Character = {
        id: String(c.id),
        name: c.name?.full || c.name?.userPreferred || cleanName,
        nativeName: c.name?.native,
        image: optimizeImageUrl(c.image?.large || c.image?.medium || ''),
        role: 'Main',
        hearts: c.favourites || 0,
        favourites: c.favourites || 0,
        gender: c.gender || 'Unknown',
        age: c.age || 'Unknown',
        birthday: bday,
        bloodType: c.bloodType || 'Unknown',
        attributes: parsed.attributes,
        bio: parsed.bio,
        rawDescription: c.description || '',
        appearedIn: appearedInList,
      };

      await swrSet(cacheKey, charItem);
      return charItem;
    } catch (err) {
      console.error('Failed to search character by name from AniList:', err);
      return null;
    }
  });
}

// -------------------------------------------------------------
// 7. GENERAL ANILIST MEDIA QUERY WITH FLEXIBLE FILTERS & SORT
// -------------------------------------------------------------

export async function fetchAniListMedia(
  type: 'ANIME' | 'MANGA' = 'ANIME',
  genre?: string,
  sort: string[] | string = ['TRENDING_DESC', 'POPULARITY_DESC'],
  perPage = 20,
  season?: string,
  seasonYear?: number,
  format?: string
): Promise<MediaItem[]> {
  const sortArg = Array.isArray(sort) ? `[${sort.join(', ')}]` : sort;
  const genreArg = genre ? `, genre: "${genre}"` : '';
  const formatArg = format ? `, format: ${format}` : '';
  const seasonArg = season ? `, season: ${season}` : '';
  const seasonYearArg = seasonYear ? `, seasonYear: ${seasonYear}` : '';

  const query = `
    query GetAniListMedia($perPage: Int) {
      Page(page: 1, perPage: $perPage) {
        media(type: ${type}${formatArg}${genreArg}${seasonArg}${seasonYearArg}, sort: ${sortArg}) {
          ${MEDIA_FIELDS}
        }
      }
    }
  `;
  try {
    const data = await fetchFromAniList<any>(query, { perPage });
    const categoryOverride: MediaCategory = type === 'ANIME' ? 'anime' : format === 'NOVEL' ? 'novel' : 'manga';
    return (data?.Page?.media || []).map((m: any) => mapAniListToMediaItem(m, categoryOverride));
  } catch (err) {
    console.warn('fetchAniListMedia failed:', err);
    return [];
  }
}

// -------------------------------------------------------------
// 8. CONTENT SOURCE STUBS (Cleared for rebuild from scratch)
// -------------------------------------------------------------

export interface MangaDexChapter {
  id: string;
  chapter: string;
  title: string;
  volume?: string;
  pages: number;
  publishAt: string;
}

export async function searchMangaDex(
  _title: string,
  _altTitles: string[] = [],
  _idMal?: string | number
): Promise<string | null> {
  return null;
}

export async function searchMangaDexList(_query: string, _limit = 20): Promise<MediaItem[]> {
  return [];
}

export async function fetchMangaDexChapters(_mangaId: string): Promise<MangaDexChapter[]> {
  return [];
}

export async function fetchMangaDexChapterPages(_chapterId: string): Promise<string[]> {
  return [];
}

export async function getMangaPages(
  _title: string,
  _chapterNumber: number,
  chapterId?: string,
  _altTitles: string[] = [],
  _anilistId?: string | number,
  _idMal?: string | number
): Promise<string[]> {
  if (!chapterId) return [];
  try {
    const res = await fetch('/api/manga/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chapterId }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.pages) ? data.pages : [];
  } catch (err) {
    console.warn('getMangaPages failed:', err);
    return [];
  }
}

export async function fetchMediaEpisodes(media: MediaItem): Promise<EpisodeItem[]> {
  if (!media?.title && !media?.id) return [];
  const cacheKey = `anime_episodes_v1_${media.id}`;
  return swrFetchDedupe(cacheKey, async () => {
    try {
      const res = await fetch('/api/anime/episodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          anilistId: media.id,
          title: media.title,
          altTitles: collectMediaAltTitles(media),
        }),
      });
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data?.episodes) ? data.episodes : [];
    } catch (err) {
      console.warn('fetchMediaEpisodes failed:', err);
      return [];
    }
  });
}

function collectMediaAltTitles(media: MediaItem): string[] {
  return [
    media.englishTitle,
    media.romajiTitle,
    media.nativeTitle,
    ...(media.synonyms || []),
  ]
    .map((t) => String(t || '').trim())
    .filter((t) => Boolean(t) && t !== media.title);
}

export async function fetchMediaMangaChapters(media: MediaItem): Promise<MangaChapterItem[]> {
  if (!media?.title) return [];
  const cacheKey = `manga_chapters_v1_${media.id}`;
  return swrFetchDedupe(cacheKey, async () => {
    try {
      const res = await fetch('/api/manga/chapters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: media.title,
          altTitles: collectMediaAltTitles(media),
        }),
      });
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data?.chapters) ? data.chapters : [];
    } catch (err) {
      console.warn('fetchMediaMangaChapters failed:', err);
      return [];
    }
  });
}

export async function resolveAccurateNovelVolumeCount(_media: MediaItem, discoveredCount: number): Promise<number> {
  return discoveredCount;
}

export async function fetchMediaNovelChapters(media: MediaItem): Promise<NovelChapterItem[]> {
  if (!media?.title) return [];
  const cacheKey = `novel_volumes_v1_${media.id}`;
  return swrFetchDedupe(cacheKey, async () => {
    try {
      const res = await fetch('/api/novel/volumes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: media.title,
          altTitles: collectMediaAltTitles(media),
        }),
      });
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data?.volumes) ? data.volumes : [];
    } catch (err) {
      console.warn('fetchMediaNovelChapters failed:', err);
      return [];
    }
  });
}

export * from './anifyService';
export * from './logoService';


