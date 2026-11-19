export interface AnifyStreamSource {
  url: string;
  quality: string;
  isM3U8?: boolean;
}

export interface AnifySubtitle {
  url: string;
  lang: string;
  label?: string;
  default?: boolean;
}

export interface AnifyStreamData {
  sources: AnifyStreamSource[];
  subtitles: AnifySubtitle[];
  intro?: { start: number; end: number };
  outro?: { start: number; end: number };
  providerId: string;
  episodeNumber: number;
}

export interface AnifyEpisode {
  id: string;
  number: number;
  title?: string;
  image?: string;
  isFiller?: boolean;
  providerId: string;
}

export interface AnifyNovelChapter {
  id: string;
  number: number;
  title: string;
  updatedAt?: number;
  providerId: string;
}

export interface AnifyNovelChapterContent {
  chapterNumber: number;
  title: string;
  content: string;
  paragraphs: string[];
  providerId: string;
}

export async function getAnifyAnimeInfo(_anilistId: string | number, _title?: string): Promise<any | null> {
  return null;
}

export async function getAnifyEpisodes(_anilistId: string | number, _title?: string): Promise<AnifyEpisode[]> {
  return [];
}

export async function getAnimeStreamSources(
  _anilistId: string | number,
  _episodeNumber: number,
  _options?: {
    providerId?: string;
    watchId?: string;
    subType?: 'sub' | 'dub';
    title?: string;
  }
): Promise<AnifyStreamData | null> {
  return null;
}

export async function getAnifyNovelInfo(_anilistId: string | number, _title?: string): Promise<any | null> {
  return null;
}

export async function getAnifyNovelChapters(_anilistId: string | number, _title?: string): Promise<AnifyNovelChapter[]> {
  return [];
}

export async function getNovelChapterContent(
  _anilistId: string | number,
  chapterNumber: number,
  options?: { providerId?: string; readId?: string; title?: string; altTitles?: string[] }
): Promise<AnifyNovelChapterContent | null> {
  try {
    const res = await fetch('/api/novel/chapter-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chapterNumber,
        readId: options?.readId,
        title: options?.title,
        altTitles: options?.altTitles || [],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.success || !data?.content) return null;
    return {
      chapterNumber: data.chapterNumber ?? chapterNumber,
      title: data.title || `Volume ${chapterNumber}`,
      content: data.content,
      paragraphs: Array.isArray(data.paragraphs) ? data.paragraphs : [],
      providerId: data.providerId || 'lnori',
    };
  } catch (err) {
    console.warn('getNovelChapterContent failed:', err);
    return null;
  }
}

export async function getSources(
  _animeId: string | number,
  _episodeNumber: number,
  _options?: {
    providerId?: string;
    watchId?: string;
    subType?: 'sub' | 'dub';
    title?: string;
  }
): Promise<AnifyStreamData | null> {
  return null;
}

export const anifyService = {
  getSources,
  getAnimeStreamSources,
  getAnifyAnimeInfo,
  getAnifyEpisodes,
  getAnifyNovelInfo,
  getAnifyNovelChapters,
  getNovelChapterContent,
};
