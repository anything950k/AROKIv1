import 'dotenv/config';
import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import {
  fetchAllMangaChapters,
  fetchMangaChapterPages,
  fetchLnoriNovelVolumes,
  fetchLnoriNovelChapterText,
  proxyImageRequest,
  fetchAnimeEpisodesList,
  resolveAnimeStreamHierarchy,
  handleHlsProxyRequest,
  handleSubtitleProxyRequest,
  AnimeServerKey,
} from './src/server/moduleRunner';

const ANILIST_GRAPHQL_URL = 'https://graphql.anilist.co';

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '10mb' }));

  // Single AniList GraphQL endpoint (no retries, no stale cache, no fallback sources)
  app.post('/api/anilist', async (req, res) => {
    try {
      const { query, variables } = req.body || {};
      const response = await fetch(ANILIST_GRAPHQL_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ query, variables }),
      });

      const text = await response.text();
      if (text.trim().startsWith('{')) {
        return res.status(response.status).json(JSON.parse(text));
      }

      return res.status(response.status >= 400 ? response.status : 502).json({
        error: 'Unexpected response from AniList',
        status: response.status,
      });
    } catch (err: any) {
      return res.status(502).json({
        error: 'Failed to reach AniList API',
        message: err?.message || 'Network error',
      });
    }
  });

  // Anime episodes (Strict Primary: Anikoto -> Fallback 1..4)
  const handleAnimeEpisodes = async (req: express.Request, res: express.Response) => {
    try {
      const src = req.method === 'POST' ? req.body || {} : req.query || {};
      const anilistId = src.anilistId ? String(src.anilistId).trim() : undefined;
      const title = String(src.title || '').trim();
      const rawAlts = src.altTitles;
      const altTitles: string[] = Array.isArray(rawAlts)
        ? rawAlts.map((t: any) => String(t || '').trim()).filter(Boolean)
        : typeof rawAlts === 'string' && rawAlts
        ? rawAlts.split('||').map((t) => t.trim()).filter(Boolean)
        : [];

      if (!title && !anilistId && altTitles.length === 0) {
        return res.status(400).json({ success: false, episodes: [], error: 'Title or anilistId required' });
      }

      const data = await fetchAnimeEpisodesList({
        anilistId,
        title: title || altTitles[0] || '',
        altTitles,
      });

      return res.json({
        success: data.episodes.length > 0,
        episodes: data.episodes,
        source: data.source,
        sourceName: data.sourceName,
      });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        episodes: [],
        error: err?.message || 'Failed to fetch anime episodes',
      });
    }
  };
  app.get('/api/anime/episodes', handleAnimeEpisodes);
  app.post('/api/anime/episodes', handleAnimeEpisodes);

  // Anime streaming sources (Strict Primary: Anikoto -> Anikage -> Miruro -> JustAnime -> KickAssAnime)
  const handleAnimeSources = async (req: express.Request, res: express.Response) => {
    try {
      const src = req.method === 'POST' ? req.body || {} : req.query || {};
      const anilistId = src.anilistId ? String(src.anilistId).trim() : undefined;
      const episodeNumber = Number(src.episodeNumber || src.episode || 1) || 1;
      const title = String(src.title || '').trim();
      const audioTrack = String(src.audioTrack || src.lang || 'sub').toLowerCase() === 'dub' ? 'dub' : 'sub';
      const preferredServer = src.preferredServer ? (String(src.preferredServer).trim() as AnimeServerKey) : 'anikoto';
      const exactServerOnly = src.exactServerOnly === true || src.exactServerOnly === 'true';

      const rawAlts = src.altTitles;
      const altTitles: string[] = Array.isArray(rawAlts)
        ? rawAlts.map((t: any) => String(t || '').trim()).filter(Boolean)
        : typeof rawAlts === 'string' && rawAlts
        ? rawAlts.split('||').map((t) => t.trim()).filter(Boolean)
        : [];

      if (!title && !anilistId && altTitles.length === 0) {
        return res.status(400).json({
          success: false,
          servers: {},
          activeServer: preferredServer,
          sources: [],
          subtitles: [],
          error: 'Title or anilistId required',
        });
      }

      const payload = await resolveAnimeStreamHierarchy({
        anilistId,
        episodeNumber,
        title: title || altTitles[0] || '',
        altTitles,
        audioTrack,
        preferredServer,
        exactServerOnly,
      });

      return res.json(payload);
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        servers: {},
        activeServer: 'anikoto',
        sources: [],
        subtitles: [],
        error: err?.message || 'Failed to resolve anime stream',
      });
    }
  };
  app.get('/api/anime/sources', handleAnimeSources);
  app.post('/api/anime/sources', handleAnimeSources);

  // HLS & Subtitle Proxies (handles CORS, Referer/Origin headers, disguised playlists/TS segments, SRT->VTT)
  app.get(['/api/hls-proxy', '/api/stream/proxy'], handleHlsProxyRequest);
  app.get('/api/subtitle-proxy', handleSubtitleProxyRequest);

  // Manga, Manhwa & Manhua: All 7 modules queried concurrently (no primary, no fallback)
  const handleMangaChapters = async (req: express.Request, res: express.Response) => {
    try {
      const src = req.method === 'POST' ? req.body || {} : req.query || {};
      const title = String(src.title || '').trim();
      const rawAlts = src.altTitles;
      const altTitles: string[] = Array.isArray(rawAlts)
        ? rawAlts.map((t: any) => String(t || '').trim()).filter(Boolean)
        : typeof rawAlts === 'string' && rawAlts
        ? rawAlts.split('||').map((t) => t.trim()).filter(Boolean)
        : [];

      if (!title && altTitles.length === 0) {
        return res.status(400).json({ success: false, chapters: [], total: 0, error: 'Title required' });
      }

      const data = await fetchAllMangaChapters({
        title: title || altTitles[0],
        altTitles,
      });

      return res.json({
        success: data.chapters.length > 0,
        chapters: data.chapters,
        total: data.total,
        sources: data.sourcesSummary,
      });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        chapters: [],
        total: 0,
        error: err?.message || 'Failed to fetch manga chapters',
      });
    }
  };
  app.get('/api/manga/chapters', handleMangaChapters);
  app.post('/api/manga/chapters', handleMangaChapters);

  // Manga pages: resolved strictly from the selected module chapterId (no fallback)
  const handleMangaPages = async (req: express.Request, res: express.Response) => {
    try {
      const src = req.method === 'POST' ? req.body || {} : req.query || {};
      const chapterId = String(src.chapterId || '').trim();
      if (!chapterId) {
        return res.status(400).json({ success: false, pages: [], error: 'chapterId required' });
      }
      const data = await fetchMangaChapterPages(chapterId);
      return res.json({
        success: data.pages.length > 0,
        pages: data.pages,
        source: data.sourceSlug,
      });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        pages: [],
        error: err?.message || 'Failed to fetch manga pages',
      });
    }
  };
  app.get('/api/manga/pages', handleMangaPages);
  app.post('/api/manga/pages', handleMangaPages);

  // Light Novel volumes: Lnori only (Primary & Final, no fallback)
  const handleNovelVolumes = async (req: express.Request, res: express.Response) => {
    try {
      const src = req.method === 'POST' ? req.body || {} : req.query || {};
      const title = String(src.title || '').trim();
      const rawAlts = src.altTitles;
      const altTitles: string[] = Array.isArray(rawAlts)
        ? rawAlts.map((t: any) => String(t || '').trim()).filter(Boolean)
        : typeof rawAlts === 'string' && rawAlts
        ? rawAlts.split('||').map((t) => t.trim()).filter(Boolean)
        : [];

      if (!title && altTitles.length === 0) {
        return res.status(400).json({ success: false, volumes: [], totalVolumes: 0, error: 'Title required' });
      }

      const data = await fetchLnoriNovelVolumes({
        title: title || altTitles[0],
        altTitles,
      });

      return res.json({
        success: data.volumes.length > 0,
        volumes: data.volumes,
        totalVolumes: data.volumes.length,
        matchedTitle: data.matchedTitle,
        source: 'lnori',
      });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        volumes: [],
        totalVolumes: 0,
        error: err?.message || 'Failed to fetch novel volumes',
      });
    }
  };
  app.get('/api/novel/volumes', handleNovelVolumes);
  app.post('/api/novel/volumes', handleNovelVolumes);

  // Light Novel chapter text: Lnori only (Primary & Final, no fallback)
  const handleNovelChapterText = async (req: express.Request, res: express.Response) => {
    try {
      const src = req.method === 'POST' ? req.body || {} : req.query || {};
      const readId = String(src.readId || src.chapterId || '').trim();
      const chapterNumber = Number(src.chapterNumber || 1) || 1;
      const title = String(src.title || '').trim();
      const rawAlts = src.altTitles;
      const altTitles: string[] = Array.isArray(rawAlts)
        ? rawAlts.map((t: any) => String(t || '').trim()).filter(Boolean)
        : typeof rawAlts === 'string' && rawAlts
        ? rawAlts.split('||').map((t) => t.trim()).filter(Boolean)
        : [];

      if (!readId && !title && altTitles.length === 0) {
        return res.status(400).json({ success: false, content: '', paragraphs: [], error: 'readId or title required' });
      }

      const data = await fetchLnoriNovelChapterText({
        readId: readId || undefined,
        chapterNumber,
        title: title || altTitles[0] || undefined,
        altTitles,
      });

      if (!data) {
        return res.json({
          success: false,
          content: '',
          paragraphs: [],
          message: 'Chapter text not found on Lnori',
        });
      }

      return res.json({
        success: true,
        ...data,
      });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        content: '',
        paragraphs: [],
        error: err?.message || 'Failed to fetch novel chapter text',
      });
    }
  };
  app.get('/api/novel/chapter-text', handleNovelChapterText);
  app.post('/api/novel/chapter-text', handleNovelChapterText);

  // Image proxy for module CDNs with Referer & Cloudflare curl support
  app.get('/api/image-proxy', async (req, res) => {
    const targetUrl = String(req.query.url || '').trim();
    const referer = String(req.query.referer || '').trim();
    if (!targetUrl || (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://'))) {
      return res.status(400).send('Invalid url parameter');
    }
    try {
      const result = await proxyImageRequest(targetUrl, referer || undefined);
      if (result.status && result.status >= 400) {
        return res.status(result.status).send(`Upstream error ${result.status}`);
      }
      res.setHeader('Content-Type', result.contentType);
      res.setHeader('Cache-Control', 'public, max-age=604800');
      return res.send(result.buffer);
    } catch (err: any) {
      return res.status(502).send(`Image proxy failed: ${err?.message || 'error'}`);
    }
  });

  // Hero Carousel PNG Logo Pipeline: Primary = TMDB, Secondary = Fanart.tv, Fallback = null (Normal Text Title)
  const serverLogoCache = new Map<string, { logoUrl: string; source: string; timestamp: number }>();
  const LOGO_CACHE_TTL = 24 * 60 * 60 * 1000;

  const normalizeLogoTitle = (str: string) =>
    str
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');

  const buildCandidateTitles = (rawTitles: (string | undefined)[]): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    const add = (t?: string) => {
      const clean = (t || '').trim();
      if (clean.length > 1 && !seen.has(clean.toLowerCase())) {
        seen.add(clean.toLowerCase());
        out.push(clean);
      }
    };

    // 1. Exact titles first (english, main, romaji)
    for (const t of rawTitles) add(t);

    // 2. Cleaned base titles (strip season/part/stage suffixes & subtitles)
    for (const t of rawTitles) {
      if (!t) continue;
      const withoutParens = t.replace(/\s*\([^)]*\)/g, '').replace(/\s*\[[^\]]*\]/g, '').trim();
      add(withoutParens);

      const withoutSeason = withoutParens
        .replace(
          /\s*(?::|-|–|—)?\s*(?:\d+(?:st|nd|rd|th)\s+Season|Season\s+\d+|Part\s+\d+|Cour\s+\d+|The\s+Final\s+Season|Final\s+Season|\d+(?:st|nd|rd|th)\s*-\s*\d+(?:st|nd|rd|th)\s+STAGE|\d+(?:st|nd|rd|th)\s+STAGE).*$/i,
          ''
        )
        .trim();
      add(withoutSeason);

      if (withoutSeason.includes(': ')) {
        const beforeColon = withoutSeason.split(': ')[0].trim();
        if (beforeColon.length >= 3) add(beforeColon);
      }
    }

    return out;
  };

  app.get('/api/media/logo', async (req, res) => {
    const title = ((req.query.title as string) || '').trim();
    const englishTitle = ((req.query.englishTitle as string) || '').trim();
    const romajiTitle = ((req.query.romajiTitle as string) || '').trim();

    if (!title && !englishTitle && !romajiTitle) {
      return res.json({ success: false, logoUrl: null, source: null, error: 'Title required' });
    }

    const tmdbApiKey = (process.env.TMDB_API_KEY || '').trim();
    const fanartApiKey = (process.env.FANART_API_KEY || '').trim();

    const cacheKey = normalizeLogoTitle(englishTitle || title || romajiTitle);
    const cached = serverLogoCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < LOGO_CACHE_TTL) {
      return res.json({
        success: true,
        logoUrl: cached.logoUrl,
        source: cached.source,
        hasTmdbKey: Boolean(tmdbApiKey),
        hasFanartKey: Boolean(fanartApiKey),
      });
    }

    const candidateTitles = buildCandidateTitles([englishTitle, title, romajiTitle]);

    let resolvedLogoUrl: string | null = null;
    let resolvedSource: 'tmdb' | 'fanart' | null = null;
    const matchedTmdbItems: { id: number; media_type: 'tv' | 'movie' }[] = [];
    const seenTmdbIds = new Set<string>();

    // 1. PRIMARY API: TMDB (Search + Rank Animation/Exact/Popular + Transparent PNG Clearlogo)
    if (tmdbApiKey) {
      for (const searchTitle of candidateTitles) {
        if (resolvedLogoUrl) break;
        try {
          const searchUrl = `https://api.themoviedb.org/3/search/multi?api_key=${encodeURIComponent(
            tmdbApiKey
          )}&query=${encodeURIComponent(searchTitle)}&include_adult=true`;
          const searchRes = await fetch(searchUrl, { headers: { Accept: 'application/json' } });
          if (!searchRes.ok) continue;

          const searchData = await searchRes.json();
          const rawResults = (searchData.results || []).filter(
            (r: any) => r.media_type === 'tv' || r.media_type === 'movie'
          );
          if (rawResults.length === 0) continue;

          const normQuery = normalizeLogoTitle(searchTitle);
          const rankedResults = [...rawResults].sort((a: any, b: any) => {
            const scoreItem = (r: any) => {
              let score = 0;
              const names = [r.name, r.title, r.original_name, r.original_title]
                .filter(Boolean)
                .map((n: string) => normalizeLogoTitle(n));
              if (names.includes(normQuery)) score += 100;
              else if (names.some((n: string) => n.startsWith(normQuery) || normQuery.startsWith(n))) score += 45;

              if (Array.isArray(r.genre_ids) && r.genre_ids.includes(16)) score += 50;
              if (r.original_language === 'ja') score += 20;
              if (r.media_type === 'tv') score += 10;
              score += Math.min(35, Math.log10((Number(r.popularity) || 1) + 1) * 12);
              return score;
            };
            return scoreItem(b) - scoreItem(a);
          });

          for (const candidate of rankedResults.slice(0, 4)) {
            const mediaType = candidate.media_type as 'tv' | 'movie';
            const tmdbId = candidate.id as number;
            const key = `${mediaType}:${tmdbId}`;
            if (!seenTmdbIds.has(key)) {
              seenTmdbIds.add(key);
              matchedTmdbItems.push({ id: tmdbId, media_type: mediaType });
            }

            const imagesUrl = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}/images?api_key=${encodeURIComponent(
              tmdbApiKey
            )}&include_image_language=en,ja,null`;
            const imgRes = await fetch(imagesUrl, { headers: { Accept: 'application/json' } });
            if (!imgRes.ok) continue;

            const imgData = await imgRes.json();
            const pngLogos = (imgData.logos || []).filter(
              (l: any) => typeof l?.file_path === 'string' && l.file_path.toLowerCase().endsWith('.png')
            );
            const logos = pngLogos.length > 0 ? pngLogos : imgData.logos || [];

            if (logos.length > 0) {
              const enLogo = logos.find((l: any) => l.iso_639_1 === 'en');
              const nullLangLogo = logos.find((l: any) => !l.iso_639_1);
              const jaLogo = logos.find((l: any) => l.iso_639_1 === 'ja');
              const chosenLogo = enLogo || nullLangLogo || jaLogo || logos[0];

              if (chosenLogo?.file_path) {
                resolvedLogoUrl = `https://image.tmdb.org/t/p/w500${chosenLogo.file_path}`;
                resolvedSource = 'tmdb';
                break;
              }
            }
          }
        } catch {
          // Continue to next candidate title
        }
      }
    }

    // 2. SECONDARY API: FANART.TV (Only if TMDB did not return a PNG logo)
    if (!resolvedLogoUrl && fanartApiKey && tmdbApiKey && matchedTmdbItems.length > 0) {
      for (const item of matchedTmdbItems.slice(0, 4)) {
        if (resolvedLogoUrl) break;
        try {
          if (item.media_type === 'tv') {
            const extRes = await fetch(
              `https://api.themoviedb.org/3/tv/${item.id}/external_ids?api_key=${encodeURIComponent(
                tmdbApiKey
              )}`,
              { headers: { Accept: 'application/json' } }
            );
            if (extRes.ok) {
              const extData = await extRes.json();
              const tvdbId = extData?.tvdb_id;
              if (tvdbId) {
                const fanartRes = await fetch(
                  `https://webservice.fanart.tv/v3/tv/${tvdbId}?api_key=${encodeURIComponent(fanartApiKey)}`,
                  { headers: { Accept: 'application/json' } }
                );
                if (fanartRes.ok) {
                  const fanartData = await fanartRes.json();
                  const allFanartLogos = [...(fanartData.hdtvlogo || []), ...(fanartData.clearlogo || [])];
                  const pngLogos = allFanartLogos.filter(
                    (l: any) => typeof l?.url === 'string' && l.url.toLowerCase().includes('.png')
                  );
                  const fanartLogos = pngLogos.length > 0 ? pngLogos : allFanartLogos;
                  if (fanartLogos.length > 0) {
                    const chosen =
                      fanartLogos.find((l: any) => l.lang === 'en') ||
                      fanartLogos.find((l: any) => l.lang === 'ja') ||
                      fanartLogos[0];
                    if (chosen?.url) {
                      resolvedLogoUrl = chosen.url;
                      resolvedSource = 'fanart';
                      break;
                    }
                  }
                }
              }
            }
          } else if (item.media_type === 'movie') {
            const fanartRes = await fetch(
              `https://webservice.fanart.tv/v3/movies/${item.id}?api_key=${encodeURIComponent(
                fanartApiKey
              )}`,
              { headers: { Accept: 'application/json' } }
            );
            if (fanartRes.ok) {
              const fanartData = await fanartRes.json();
              const allFanartLogos = [...(fanartData.hdmovielogo || []), ...(fanartData.movielogo || [])];
              const pngLogos = allFanartLogos.filter(
                (l: any) => typeof l?.url === 'string' && l.url.toLowerCase().includes('.png')
              );
              const fanartLogos = pngLogos.length > 0 ? pngLogos : allFanartLogos;
              if (fanartLogos.length > 0) {
                const chosen =
                  fanartLogos.find((l: any) => l.lang === 'en') ||
                  fanartLogos.find((l: any) => l.lang === 'ja') ||
                  fanartLogos[0];
                if (chosen?.url) {
                  resolvedLogoUrl = chosen.url;
                  resolvedSource = 'fanart';
                  break;
                }
              }
            }
          }
        } catch {
          // Try next matched item or fall through to text title
        }
      }
    }

    if (resolvedLogoUrl && resolvedSource) {
      serverLogoCache.set(cacheKey, {
        logoUrl: resolvedLogoUrl,
        source: resolvedSource,
        timestamp: Date.now(),
      });
    }

    return res.json({
      success: Boolean(resolvedLogoUrl),
      logoUrl: resolvedLogoUrl,
      source: resolvedSource,
      hasTmdbKey: Boolean(tmdbApiKey),
      hasFanartKey: Boolean(fanartApiKey),
    });
  });

  // Health check route
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Vite development middleware vs production static files
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
