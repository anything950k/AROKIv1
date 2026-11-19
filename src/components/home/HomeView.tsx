import React, { useMemo, useState } from 'react';
import { Play, X } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { TopCategoryHeader } from '../layout/TopCategoryHeader';
import { HeroCarousel } from './HeroCarousel';
import {
  fetchTrendingAnime,
  fetchPopularThisSeason,
  fetchNewEpisodes,
  fetchCommunityLovedAnime,
  fetchRecentlyCompletedAnime,
  fetchAnimeMovies,
  fetchUpcomingAnime,
  fetchTrendingManga,
  fetchPopularManga,
  fetchRecentlyUpdatedManga,
  fetchCommunityLovedManga,
  fetchRecentlyCompletedManga,
  fetchTrendingNovels,
  fetchSeasonalNovels,
  fetchPopularNovels,
  fetchMonsterNovels,
  fetchPrincessNovels,
  fetchMagicNovels,
} from '../../services/api';
import { MediaItem } from '../../types';
import { MediaHorizontalList, MediaRow } from './MediaHorizontalList';
import { useCachedApi } from '../../hooks/useCachedApi';

export const HomeView: React.FC = () => {
  const {
    activeCategory,
    openMediaDetails,
    setActiveReader,
    setActiveVideoEpisode,
    mangaReadingHistory,
    removeFromMangaHistory,
    animeWatchHistory,
    removeFromAnimeHistory,
  } = useApp();

  const [pendingRemoveItem, setPendingRemoveItem] = useState<{
    mediaId: string | number;
    type: 'anime' | 'manga' | 'novel';
  } | null>(null);

  // ================= 1. ANIME DYNAMIC SECTIONS (ALL 6 PRESERVED - EXPANDED LIMITLESS FETCH) =================
  const { data: trendingAnime = [] } = useCachedApi('home_anime_trending_15', () => fetchTrendingAnime(15));
  const { data: popularSeason = [], loading: loadingSeason } = useCachedApi('home_anime_popular_season_active_30', () => fetchPopularThisSeason(30));
  const { data: newEpisodes = [], loading: loadingNewEps } = useCachedApi('home_anime_new_episodes_40', () => fetchNewEpisodes(40));
  const { data: communityLovedAnime = [], loading: loadingLovedAnime } = useCachedApi('home_anime_community_loved_30', () => fetchCommunityLovedAnime(30));
  const { data: recentlyCompletedAnime = [], loading: loadingCompletedAnime } = useCachedApi('home_anime_recently_completed_30', () => fetchRecentlyCompletedAnime(30));
  const { data: animeMovies = [], loading: loadingMovies } = useCachedApi('home_anime_movies_30', () => fetchAnimeMovies(30));
  const { data: upcomingAnime = [], loading: loadingUpcomingAnime } = useCachedApi('home_anime_upcoming_50', () => fetchUpcomingAnime(50));

  // ================= 2. MANGA DYNAMIC SECTIONS (ALL PRESERVED - EXPANDED LIMITLESS FETCH) =================
  const { data: trendingManga = [] } = useCachedApi('home_manga_trending_15', () => fetchTrendingManga(15));
  const { data: popularManga = [], loading: loadingPopManga } = useCachedApi('home_manga_popular_30', () => fetchPopularManga(30));
  const { data: recentlyUpdatedManga = [], loading: loadingUpdatedManga } = useCachedApi('home_manga_recently_updated_40', () => fetchRecentlyUpdatedManga(40));
  const { data: communityLovedManga = [], loading: loadingLovedManga } = useCachedApi('home_manga_community_loved_30', () => fetchCommunityLovedManga(30));
  const { data: recentlyCompletedManga = [], loading: loadingCompletedManga } = useCachedApi('home_manga_recently_completed_30', () => fetchRecentlyCompletedManga(30));

  // ================= 3. NOVEL DYNAMIC SECTIONS (ALL 6 PRESERVED - EXPANDED LIMITLESS FETCH) =================
  const { data: trendingNovels = [] } = useCachedApi('home_novel_trending_15', () => fetchTrendingNovels(15));
  const { data: seasonalNovels = [], loading: loadingSeasonalNovels } = useCachedApi('home_novel_seasonal_30', () => fetchSeasonalNovels(30));
  const { data: popularNovels = [], loading: loadingPopNovels } = useCachedApi('home_novel_popular_30', () => fetchPopularNovels(30));
  const { data: monsterNovels = [], loading: loadingMonsterNovels } = useCachedApi('home_novel_monsters_30', () => fetchMonsterNovels(30));
  const { data: princessNovels = [], loading: loadingPrincessNovels } = useCachedApi('home_novel_princess_30', () => fetchPrincessNovels(30));
  const { data: magicNovels = [], loading: loadingMagicNovels } = useCachedApi('home_novel_magic_30', () => fetchMagicNovels(30));

  // Filter history per media category
  const mangaHistoryOnly = useMemo(() => {
    return mangaReadingHistory.filter((entry) => entry.category !== 'novel');
  }, [mangaReadingHistory]);

  const novelReadingHistory = useMemo(() => {
    return mangaReadingHistory.filter((entry) => entry.category === 'novel');
  }, [mangaReadingHistory]);

  // Dynamic hero items selection based on active category
  const heroItems = useMemo(() => {
    if (activeCategory === 'anime') return trendingAnime;
    if (activeCategory === 'manga') return trendingManga;
    if (activeCategory === 'novel') return trendingNovels;
    return [];
  }, [activeCategory, trendingAnime, trendingManga, trendingNovels]);

  // Combined loading indicator per category
  const loading = useMemo(() => {
    if (activeCategory === 'anime') {
      return loadingSeason && popularSeason.length === 0;
    }
    if (activeCategory === 'manga') {
      return loadingPopManga && popularManga.length === 0;
    }
    if (activeCategory === 'novel') {
      return loadingSeasonalNovels && seasonalNovels.length === 0;
    }
    return false;
  }, [
    activeCategory,
    loadingSeason,
    popularSeason.length,
    loadingPopManga,
    popularManga.length,
    loadingSeasonalNovels,
    seasonalNovels.length,
  ]);

  return (
    <div className="w-full min-h-screen bg-black text-white pb-28 select-none">
      {/* 1. HERO CAROUSEL BANNER & GRADIENT FADE */}
      <HeroCarousel
        activeCategory={activeCategory}
        onSelectMedia={openMediaDetails}
        passedItems={heroItems}
      />

      {/* 2. CATEGORY SWITCHER CAPSULE PILLS (ANIME / MANGA / NOVEL) */}
      <div className="px-4 mt-3 mb-2">
        <TopCategoryHeader />
      </div>

      {/* 3. DYNAMIC CONTENT SECTIONS BY CATEGORY (Zero-Latency Persistent Mount) */}
      <div className="px-4 mt-4">
        {/* ===================== ANIME TAB (ALL 6 SECTIONS INTACT) ===================== */}
        <div className={activeCategory === 'anime' ? 'space-y-6 block' : 'hidden'}>
          {/* Continue Watching Card (Dedicated Real Watch History) */}
          {animeWatchHistory.length > 0 && (
            <div className="space-y-2">
              <SectionHeader firstWord="Continue" secondWord="Watching" highlight="first" />
              <div className="flex gap-3 overflow-x-auto no-scrollbar -mx-4 px-4 py-1">
                {animeWatchHistory.map((entry) => {
                  const thumbSrc = entry.lastFrame || entry.bannerImage || entry.coverImage;
                  const totalDuration = entry.duration && entry.duration > 0 ? entry.duration : 0;
                  const watchedTime = entry.currentTime && entry.currentTime > 0 ? entry.currentTime : 0;
                  const progressPct =
                    totalDuration > 0
                      ? Math.min(100, Math.max(0, (watchedTime / totalDuration) * 100))
                      : Math.min(100, Math.max(0, entry.progressPercent || 0));

                  const remainingLabel = (() => {
                    if (totalDuration <= 0) return 'Resume';
                    const rem = Math.max(0, totalDuration - watchedTime);
                    if (rem <= 0) return '0m left';
                    if (rem < 60) return `${Math.ceil(rem)}s left`;
                    if (rem >= 3600) {
                      const hrs = Math.floor(rem / 3600);
                      const mins = Math.round((rem % 3600) / 60);
                      return mins > 0 ? `${hrs}h ${mins}m left` : `${hrs}h left`;
                    }
                    return `${Math.max(1, Math.round(rem / 60))}m left`;
                  })();

                  return (
                    <div
                      key={entry.mediaId}
                      onClick={() => {
                        const mItem: MediaItem = {
                          id: entry.mediaId,
                          title: entry.title,
                          coverImage: entry.coverImage,
                          bannerImage: entry.bannerImage,
                          category: 'anime',
                          format: 'TV',
                          status: 'Releasing',
                          score: entry.score || 8.5,
                          year: 2026,
                          genres: entry.genres || ['Action', 'Fantasy'],
                          description: entry.description || 'Continue watching anime.',
                          totalEpisodes: entry.totalEpisodes,
                        };
                        setActiveVideoEpisode({
                          media: mItem,
                          episodeNumber: entry.lastWatchedEpisode || 1,
                          initialTime: entry.currentTime || 0,
                        });
                      }}
                      className="relative w-[440px] sm:w-[500px] h-[178px] sm:h-[202px] shrink-0 rounded-2xl overflow-hidden bg-[#121214] shadow-lg cursor-pointer select-none group"
                    >
                      {thumbSrc && thumbSrc.trim() !== '' ? (
                        <img
                          src={thumbSrc}
                          alt={entry.title}
                          className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform duration-300"
                        />
                      ) : (
                        <div className="w-full h-full bg-[#1a1b26]" />
                      )}

                      {/* Subtle top & bottom gradient scrims for clean white typography contrast */}
                      <div className="absolute inset-0 bg-gradient-to-b from-black/50 via-black/10 to-black/80 pointer-events-none" />

                      {/* Top-Left Episode Number */}
                      <span
                        className="absolute top-3 left-3.5 text-[30px] sm:text-[34px] font-extrabold text-white leading-none tracking-tight drop-shadow-[0_2px_6px_rgba(0,0,0,0.65)]"
                        style={{ fontFamily: "'Montserrat', 'Plus Jakarta Sans', sans-serif" }}
                      >
                        {entry.lastWatchedEpisode}
                      </span>

                      {/* Top-Right Close / Remove Button */}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setPendingRemoveItem({ mediaId: entry.mediaId, type: 'anime' });
                        }}
                        title="Remove from history"
                        aria-label="Remove from history"
                        className="absolute top-2 right-2.5 p-1 rounded-full text-white/95 hover:text-white hover:bg-black/35 cursor-pointer transition-colors"
                      >
                        <X className="w-5 h-5 stroke-[2.2] drop-shadow-[0_2px_4px_rgba(0,0,0,0.7)]" />
                      </button>

                      {/* Center Outlined White Play Icon */}
                      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                        <Play className="w-10 h-10 sm:w-11 sm:h-11 text-white fill-none stroke-[2] drop-shadow-[0_2px_10px_rgba(0,0,0,0.65)] group-hover:scale-110 transition-transform" />
                      </div>

                      {/* Bottom-Left Anime Title */}
                      <h3 className="absolute bottom-4 left-3.5 right-[104px] text-[14px] sm:text-[15px] font-semibold text-white truncate leading-tight drop-shadow-[0_1px_4px_rgba(0,0,0,0.85)]">
                        {entry.title}
                      </h3>

                      {/* Bottom-Right Time Remaining Pill */}
                      <div className="absolute bottom-3 right-3 px-3 py-2 rounded-full bg-black/65 backdrop-blur-sm text-[11px] sm:text-xs font-semibold text-white leading-none">
                        {remainingLabel}
                      </div>

                      {/* Bottom Progress Bar (Flush with Card Bottom Corner Edges) */}
                      <div className="absolute bottom-0 inset-x-0 h-[6px] bg-white/30 overflow-hidden pointer-events-none">
                        <div
                          className="h-full rounded-r-full bg-[#A755F7] transition-all duration-300"
                          style={{
                            width: `${progressPct}%`,
                            minWidth: progressPct > 0 ? '8px' : '0px',
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 1. Popular This Season */}
          <SectionHeader firstWord="Popular" secondWord="This Season" highlight="first" />
          <MediaRow items={popularSeason} loading={loading} showScore />

          {/* 2. New Episodes */}
          <SectionHeader firstWord="New" secondWord="Episodes" highlight="second" />
          <MediaRow items={newEpisodes} loading={loading} showEpisodeBadge />

          {/* 3. Community Favorites */}
          <SectionHeader firstWord="Community" secondWord="Favorites" highlight="first" />
          <MediaRow items={communityLovedAnime} loading={loading} showScore={false} showHeartCount={false} />

          {/* 4. Recently Completed */}
          <SectionHeader firstWord="Recently" secondWord="Completed" highlight="second" />
          <MediaRow items={recentlyCompletedAnime} loading={loading} showScore />

          {/* 5. Movies */}
          <SectionHeader firstWord="Movies" highlight="none" />
          <MediaRow items={animeMovies} loading={loading} showScore />

          {/* 6. Upcoming Anime */}
          <SectionHeader firstWord="Upcoming" secondWord="Anime" highlight="first" />
          <MediaRow items={upcomingAnime} loading={loading} isUpcoming showScore={false} />
        </div>

        {/* ===================== MANGA TAB (ALL DYNAMIC SECTIONS INTACT) ===================== */}
        <div className={activeCategory === 'manga' ? 'space-y-6 block' : 'hidden'}>
          {/* 1. Continue Reading Card (Dedicated Real Manga Reading History) */}
          {mangaHistoryOnly.length > 0 && (
            <div className="space-y-2">
              <SectionHeader firstWord="Continue" secondWord="Reading" highlight="first" />
              <div className="flex gap-3 overflow-x-auto no-scrollbar -mx-4 px-4 py-1">
                {mangaHistoryOnly.map((entry) => {
                  const mItem: MediaItem = {
                    id: entry.mediaId,
                    title: entry.title,
                    coverImage: entry.coverImage,
                    bannerImage: entry.bannerImage,
                    category: 'manga',
                    format: 'Manga',
                    status: 'Releasing',
                    score: entry.score || 8.5,
                    year: 2026,
                    genres: entry.genres || ['Action', 'Adventure'],
                    description: entry.description || 'Continue reading manga.',
                    totalChapters: entry.totalChapters,
                  };
                  return (
                  <div
                    key={entry.mediaId}
                    onClick={() => {
                      setActiveReader({
                        media: mItem,
                        chapterNumber: entry.lastReadChapter,
                        chapterId: entry.lastReadChapterId,
                        initialPage: entry.lastReadPage || 1,
                      });
                    }}
                    className="relative w-[440px] sm:w-[500px] h-[125px] sm:h-[140px] shrink-0 bg-[#121214] rounded-3xl px-3.5 sm:px-4 py-2 border-0 flex items-center gap-3.5 cursor-pointer transition-all shadow-lg select-none group"
                  >
                    {entry.coverImage && entry.coverImage.trim() !== '' ? (
                      <img
                        src={entry.coverImage}
                        alt={entry.title}
                        onClick={(e) => {
                          e.stopPropagation();
                          openMediaDetails(mItem);
                        }}
                        className="w-[82px] h-[108px] sm:w-[90px] sm:h-[120px] object-cover rounded-2xl shadow-md shrink-0 group-hover:scale-[1.02] transition-transform cursor-pointer"
                      />
                    ) : (
                      <div
                        onClick={(e) => {
                          e.stopPropagation();
                          openMediaDetails(mItem);
                        }}
                        className="w-[82px] h-[108px] sm:w-[90px] sm:h-[120px] bg-[#1a1b26] rounded-2xl shadow-md shrink-0 cursor-pointer"
                      />
                    )}
                    <div className="flex-1 min-w-0 pr-6 flex flex-col justify-center">
                      <h3 className="text-[14.5px] sm:text-[15.5px] font-bold text-white line-clamp-2 leading-snug">{entry.title}</h3>
                      <div className="mt-2.5 inline-flex items-center self-start px-3.5 py-1 rounded-full text-xs font-medium bg-[#2a2a2c] text-white/90 border-0">
                        Chapter {entry.lastReadChapter}
                      </div>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setPendingRemoveItem({ mediaId: entry.mediaId, type: 'manga' });
                      }}
                      title="Remove from history"
                      className="absolute top-3.5 right-3.5 p-1 rounded-full text-white hover:bg-white/10 cursor-pointer transition-colors"
                    >
                      <X className="w-5 h-5 stroke-[2.2]" />
                    </button>
                  </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 2. Popular Manga */}
          <SectionHeader firstWord="Popular" secondWord="Manga" highlight="first" />
          <MediaRow items={popularManga} loading={loading} showScore />

          {/* 3. Recently Updated */}
          <SectionHeader firstWord="Recently" secondWord="Updated" highlight="second" />
          <MediaRow items={recentlyUpdatedManga} loading={loading} showScore />

          {/* 4. Community Favorites Manga */}
          <SectionHeader firstWord="Community" secondWord="Favorites" highlight="first" />
          <MediaRow items={communityLovedManga} loading={loading} showScore={false} showHeartCount={false} />

          {/* 5. Recently Completed */}
          <SectionHeader firstWord="Recently" secondWord="Completed" highlight="second" />
          <MediaRow items={recentlyCompletedManga} loading={loading} showScore />
        </div>

        {/* ===================== NOVEL TAB (ALL 6 SECTIONS INTACT) ===================== */}
        <div className={activeCategory === 'novel' ? 'space-y-6 block' : 'hidden'}>
          {/* Continue Reading Card (Dedicated Real Novel Reading History) */}
          {novelReadingHistory.length > 0 && (
            <div className="space-y-2">
              <SectionHeader firstWord="Continue" secondWord="Reading" highlight="first" />
              <div className="flex gap-3 overflow-x-auto no-scrollbar -mx-4 px-4 py-1">
                {novelReadingHistory.map((entry) => {
                  const mItem: MediaItem = {
                    id: entry.mediaId,
                    title: entry.title,
                    coverImage: entry.coverImage,
                    bannerImage: entry.bannerImage,
                    category: 'novel',
                    format: 'Novel',
                    status: 'Releasing',
                    score: entry.score || 8.5,
                    year: 2026,
                    genres: entry.genres || ['Fantasy', 'Adventure'],
                    description: entry.description || 'Continue reading novel.',
                    totalChapters: entry.totalChapters,
                    totalVolumes: entry.totalChapters,
                  };
                  return (
                  <div
                    key={entry.mediaId}
                    onClick={() => {
                      setActiveReader({
                        media: mItem,
                        chapterNumber: entry.lastReadChapter,
                        chapterId: entry.lastReadChapterId,
                        initialPage: entry.lastReadPage || 1,
                      });
                    }}
                    className="relative w-[440px] sm:w-[500px] h-[125px] sm:h-[140px] shrink-0 bg-[#121214] rounded-3xl px-3.5 sm:px-4 py-2 border-0 flex items-center gap-3.5 cursor-pointer transition-all shadow-lg select-none group"
                  >
                    {entry.coverImage && entry.coverImage.trim() !== '' ? (
                      <img
                        src={entry.coverImage}
                        alt={entry.title}
                        onClick={(e) => {
                          e.stopPropagation();
                          openMediaDetails(mItem);
                        }}
                        className="w-[82px] h-[108px] sm:w-[90px] sm:h-[120px] object-cover rounded-2xl shadow-md shrink-0 group-hover:scale-[1.02] transition-transform cursor-pointer"
                      />
                    ) : (
                      <div
                        onClick={(e) => {
                          e.stopPropagation();
                          openMediaDetails(mItem);
                        }}
                        className="w-[82px] h-[108px] sm:w-[90px] sm:h-[120px] bg-[#1a1b26] rounded-2xl shadow-md shrink-0 cursor-pointer"
                      />
                    )}
                    <div className="flex-1 min-w-0 pr-6 flex flex-col justify-center">
                      <h3 className="text-[14.5px] sm:text-[15.5px] font-bold text-white line-clamp-2 leading-snug">{entry.title}</h3>
                      <div className="mt-2.5 inline-flex items-center self-start px-3.5 py-1 rounded-full text-xs font-medium bg-[#2a2a2c] text-white/90 border-0">
                         Volume {entry.lastReadChapter}
                      </div>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setPendingRemoveItem({ mediaId: entry.mediaId, type: 'novel' });
                      }}
                      title="Remove from history"
                      className="absolute top-3.5 right-3.5 p-1 rounded-full text-white hover:bg-white/10 cursor-pointer transition-colors"
                    >
                      <X className="w-5 h-5 stroke-[2.2]" />
                    </button>
                  </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 1. Top Seasonal Banner: SUMMER 2026 Novels */}
          <SectionHeader firstWord="SUMMER 2026" secondWord="Novels" highlight="none" />
          <MediaRow items={seasonalNovels} loading={loading} showScore />

          {/* 2. Popular Novels */}
          <SectionHeader firstWord="Popular" secondWord="Novels" highlight="first" />
          <MediaRow items={popularNovels} loading={loading} showScore />

          {/* 3. Monsters Section */}
          <SectionHeader firstWord="Monsters" highlight="none" />
          <MediaRow items={monsterNovels} loading={loading} showScore />

          {/* 4. Princess Section */}
          <SectionHeader firstWord="Princess" highlight="none" />
          <MediaRow items={princessNovels} loading={loading} showScore />

          {/* 5. Magic Section */}
          <SectionHeader firstWord="Magic" highlight="none" />
          <MediaRow items={magicNovels} loading={loading} showScore />
        </div>
      </div>

      {/* Confirmation Dialog for Removing Continue Watching / Continue Reading Cards */}
      {pendingRemoveItem && (
        <div
          onClick={() => setPendingRemoveItem(null)}
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/75 px-4 animate-in fade-in duration-150"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-[440px] max-w-[calc(100vw-2rem)] sm:w-[500px] h-[178px] sm:h-[202px] bg-[#141416] border-0 outline-none rounded-[28px] px-6 py-5 sm:py-6 shadow-2xl flex flex-col justify-between"
          >
            <div>
              <h3 className="text-[20px] sm:text-[21px] font-bold text-white leading-snug">
                {pendingRemoveItem.type === 'anime'
                  ? 'Remove from continue watching?'
                  : 'Remove from continue reading?'}
              </h3>
              <p className="mt-2.5 text-[14.5px] sm:text-[15px] text-white/75 font-normal leading-relaxed">
                {pendingRemoveItem.type === 'anime'
                  ? 'Remove this anime from your continue watching list?'
                  : pendingRemoveItem.type === 'manga'
                  ? 'Remove this manga from your continue reading list?'
                  : 'Remove this novel from your continue reading list?'}
              </p>
            </div>
            <div className="flex items-center justify-end gap-7">
              <button
                type="button"
                onClick={() => setPendingRemoveItem(null)}
                className="text-[14px] sm:text-[14.5px] font-semibold text-[#A755F7] hover:text-[#b977fa] transition-colors cursor-pointer px-1 py-1 border-0 outline-none"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  if (pendingRemoveItem.type === 'anime') {
                    removeFromAnimeHistory(pendingRemoveItem.mediaId);
                  } else {
                    removeFromMangaHistory(pendingRemoveItem.mediaId);
                  }
                  setPendingRemoveItem(null);
                }}
                className="text-[14px] sm:text-[14.5px] font-semibold text-[#A755F7] hover:text-[#b977fa] transition-colors cursor-pointer px-1 py-1 border-0 outline-none"
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// Section header with #A755F7/white accents
interface SectionHeaderProps {
  firstWord: string;
  secondWord?: string;
  highlight?: 'first' | 'second' | 'none';
}

const SectionHeader: React.FC<SectionHeaderProps> = ({
  firstWord,
  secondWord,
  highlight = 'first',
}) => {
  return (
    <div className="flex items-center justify-between mb-1">
      <h2 className="text-[17px] sm:text-lg font-bold tracking-tight">
        {highlight === 'none' ? (
          <>
            <span className="text-white font-bold">{firstWord}</span>
            {secondWord && <span className="text-white font-bold"> {secondWord}</span>}
          </>
        ) : highlight === 'first' ? (
          <>
            <span className="text-[#A755F7] font-bold">{firstWord}</span>{' '}
            {secondWord && <span className="text-white font-bold">{secondWord}</span>}
          </>
        ) : (
          <>
            <span className="text-white font-bold">{firstWord}</span>{' '}
            {secondWord && <span className="text-[#A755F7] font-bold">{secondWord}</span>}
          </>
        )}
      </h2>
    </div>
  );
};

