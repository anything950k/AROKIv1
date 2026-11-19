import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  ChevronLeft,
  Play,
  Pause,
  Lock,
  Unlock,
  Captions,
  ListVideo,
  Grid2X2,
  Gauge,
  Maximize,
  Minimize,
  Maximize2,
  Minimize2,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  Sparkles,
  Check,
  X,
  AlertCircle,
  RefreshCw,
  Sliders,
  Tv,
  Server,
  Subtitles,
  Search,
  Radio,
  Zap,
  ShieldCheck,
  ExternalLink,
  ChevronRight,
  Minus,
  Plus,
  Sun,
  ChevronsLeft,
  ChevronsRight,
  Settings,
  FastForward,
} from 'lucide-react';
import Hls from 'hls.js';
import { useApp } from '../../context/AppContext';
import { DotPulseLoader } from '../common/DotPulseLoader';
import { fetchMediaEpisodes } from '../../services/apiClient';
import {
  resolveStreamWithFallbacks,
  ResolvedStreamPayload,
  AnimeStreamServer,
  ANIME_SERVER_ORDER,
  SERVER_METADATA,
  VideoStreamSource,
} from '../../services/streamResolver';
import { EpisodeItem } from '../../types';
import { loadCustomFontFromStorage } from '../../utils/customFontHelper';
import {
  getSubtitleFontFamily,
  getSubtitleTextColorHex,
  getSubtitleBackgroundHex,
  getSubtitleEdgeTextShadow,
} from '../settings/SettingsView';

type ActiveDrawer = 'subtitles' | 'episodes' | 'quality' | 'speed' | 'subdelay' | 'settings' | null;

interface ParsedSubtitleCue {
  id: string;
  startSeconds: number;
  endSeconds: number;
  formattedTime: string;
  text: string;
}

export const VideoPlayerModal: React.FC = () => {
  const {
    activeVideoEpisode,
    setActiveVideoEpisode,
    settings,
    updateLibraryProgress,
    recordAnimeWatchProgress,
    showToast,
  } = useApp();

  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const controlsTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const unlockPromptTimerRef = useRef<NodeJS.Timeout | null>(null);
  const stallTimerRef = useRef<NodeJS.Timeout | null>(null);
  const savedTimestampRef = useRef<number>(activeVideoEpisode?.initialTime || 0);
  const lastRecordedTimeRef = useRef<number>(activeVideoEpisode?.initialTime || 0);
  const lastCapturedFrameRef = useRef<string | undefined>(undefined);
  const hasAppliedInitialSeekRef = useRef<boolean>(false);
  const pendingResumeTimeRef = useRef<number | null>(null);
  const userPausedRef = useRef<boolean>(false);
  const triggerAutoFailoverRef = useRef<(reason: string) => void>(() => {});
  const selectedQualityRef = useRef<string>('Auto (HLS)');
  const prefetchedNextRef = useRef<{ key: string; data: ResolvedStreamPayload } | null>(null);
  const prefetchedPromiseRef = useRef<{
    key: string;
    promise: Promise<ResolvedStreamPayload | null>;
  } | null>(null);
  const prefetchedAttemptKeyRef = useRef<string | null>(null);
  const prefetchAbortRef = useRef<AbortController | null>(null);

  // Playback state
  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [bufferedTime, setBufferedTime] = useState(0);
  const [upNextCountdown, setUpNextCountdown] = useState<number | null>(null);
  const [currentTime, setCurrentTime] = useState(activeVideoEpisode?.initialTime || 0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.9);
  const [isMuted, setIsMuted] = useState(false);
  const [brightness, setBrightness] = useState(1);
  const [showControls, setShowControls] = useState(true);
  const [isLocked, setIsLocked] = useState(false);
  const [showUnlockPrompt, setShowUnlockPrompt] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isVideoFrameZoomed, setIsVideoFrameZoomed] = useState(false);
  // Landscape-first layout mode (defaults to true for widescreen anime streaming)
  const [landscapeFirst, setLandscapeFirst] = useState(true);
  const isScrubbingRef = useRef(false);

  // Double-Tap Seek & Swipe Brightness/Volume HUD state
  const [doubleTapIndicator, setDoubleTapIndicator] = useState<{
    side: 'left' | 'right';
    seconds: number;
    key: number;
  } | null>(null);
  const [swipeHud, setSwipeHud] = useState<{
    type: 'brightness' | 'volume';
    percent: number;
  } | null>(null);
  const [isHoldSpeed2x, setIsHoldSpeed2x] = useState(false);

  const currentTimeRef = useRef(currentTime);
  const volumeRef = useRef(volume);
  const isMutedRef = useRef(isMuted);
  const brightnessRef = useRef(brightness);
  useEffect(() => {
    currentTimeRef.current = currentTime;
  }, [currentTime]);
  useEffect(() => {
    volumeRef.current = volume;
  }, [volume]);
  useEffect(() => {
    isMutedRef.current = isMuted;
  }, [isMuted]);
  useEffect(() => {
    brightnessRef.current = brightness;
  }, [brightness]);

  const singleTapTimerRef = useRef<NodeJS.Timeout | null>(null);
  const doubleTapTimerRef = useRef<NodeJS.Timeout | null>(null);
  const swipeHudTimerRef = useRef<NodeJS.Timeout | null>(null);
  const suppressClickTimerRef = useRef<NodeJS.Timeout | null>(null);
  const hold2xTimerRef = useRef<NodeJS.Timeout | null>(null);
  const suppressNextClickRef = useRef<boolean>(false);
  const lastTouchTimeRef = useRef<number>(0);
  const activeDoubleTapSideRef = useRef<'left' | 'right' | null>(null);
  const lastTapRef = useRef<{ time: number; zone: 'left' | 'center' | 'right' } | null>(null);
  const gestureRef = useRef<{
    pointerId: number;
    startVisualX: number;
    startVisualY: number;
    visualW: number;
    visualH: number;
    side: 'left' | 'right';
    startBrightness: number;
    startVolume: number;
    mode: 'pending' | 'brightness' | 'volume' | 'speed2x' | 'cancelled';
    moved: boolean;
  } | null>(null);

  // Auto-lock to landscape orientation on mount for landscape-first streaming
  useEffect(() => {
    if (window.screen && 'orientation' in window.screen) {
      const orientation = window.screen.orientation as any;
      if (orientation && typeof orientation.lock === 'function') {
        orientation.lock('landscape').catch(() => {});
      }
    }
    return () => {
      if (window.screen && 'orientation' in window.screen) {
        const orientation = window.screen.orientation as any;
        if (orientation && typeof orientation.unlock === 'function') {
          orientation.unlock();
        }
      }
    };
  }, []);

  // Drawers state
  const [activeDrawer, setActiveDrawer] = useState<ActiveDrawer>(null);
  const [episodeSearchQuery, setEpisodeSearchQuery] = useState('');

  // Audio, Subtitle, Speed, Quality
  const [audioTrack, setAudioTrack] = useState<'sub' | 'dub'>('sub');
  const [selectedSubtitle, setSelectedSubtitle] = useState<string>('English');
  const [subtitleServerIndex, setSubtitleServerIndex] = useState<number>(1);
  const [audioServerIndex, setAudioServerIndex] = useState<number>(1);
  const [subDelayMs, setSubDelayMs] = useState<number>(0);
  const [tempSubDelayMs, setTempSubDelayMs] = useState<number>(0);
  const [parsedSubtitleCues, setParsedSubtitleCues] = useState<ParsedSubtitleCue[]>([]);
  const [isLoadingSubCues, setIsLoadingSubCues] = useState<boolean>(false);
  const [liveSubTime, setLiveSubTime] = useState<number>(activeVideoEpisode?.initialTime || 0);
  const [showSubDelay, setShowSubDelay] = useState<boolean>(false);
  const [playbackSpeed, setPlaybackSpeed] = useState<string>(settings.playbackSpeed || '1.00x');
  const [isDraggingSpeedRuler, setIsDraggingSpeedRuler] = useState<boolean>(false);
  const speedRulerDragRef = useRef<{
    pointerId: number;
    startVisualX: number;
    startSpeed: number;
    moved: boolean;
  } | null>(null);
  const [selectedQuality, setSelectedQuality] = useState<string>('Auto (HLS)');
  const [availableQualities, setAvailableQualities] = useState<string[]>(['Auto (HLS)']);
  const [activeAutoHeight, setActiveAutoHeight] = useState<number | null>(null);

  // Strict Anime Server Priority state (Primary: Anikoto -> Fallback 1..4)
  const [selectedServer, setSelectedServer] = useState<AnimeStreamServer>('anikoto');
  const failedServersRef = useRef<Set<AnimeStreamServer>>(new Set());
  const [ambientLightEnabled, setAmbientLightEnabled] = useState<boolean>(settings.ambientLight || false);

  // Stream data from resolver
  const [streamData, setStreamData] = useState<ResolvedStreamPayload | null>(null);
  const [activeSourceIndex, setActiveSourceIndex] = useState(0);
  const [isLoadingStream, setIsLoadingStream] = useState(true);

  // Restore any imported custom device font so custom subtitle font renders immediately inside the player
  useEffect(() => {
    loadCustomFontFromStorage();
  }, []);

  // Load and parse real episode subtitles (VTT/SRT) with exact millisecond timestamps
  useEffect(() => {
    let isCancelled = false;

    const parseSubTimestamp = (ts: string): number | null => {
      const m = ts.trim().match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/);
      if (!m) return null;
      const h = m[1] ? parseInt(m[1], 10) : 0;
      const min = parseInt(m[2], 10);
      const sec = parseInt(m[3], 10);
      const msStr = (m[4] || '0').padEnd(3, '0').slice(0, 3);
      const ms = parseInt(msStr, 10);
      return h * 3600 + min * 60 + sec + ms / 1000;
    };

    async function loadSubtitleCues() {
      if (selectedSubtitle === 'Off') {
        setParsedSubtitleCues([]);
        return;
      }

      setIsLoadingSubCues(true);

      const tracks = streamData?.subtitles || [];
      const matched =
        tracks.find((t) => (t.label || t.lang || '').toLowerCase() === selectedSubtitle.toLowerCase()) ||
        tracks.find((t) => (t.label || t.lang || '').toLowerCase().includes(selectedSubtitle.toLowerCase())) ||
        tracks.find((t) => (t.label || t.lang || '').toLowerCase().includes('english')) ||
        tracks[0];

      const rawSubUrl = matched?.url?.trim() || '';
      if (matched && (rawSubUrl.startsWith('/api/subtitle-proxy') || rawSubUrl.startsWith('http'))) {
        try {
          const proxiedUrl = rawSubUrl.startsWith('/api/subtitle-proxy')
            ? rawSubUrl
            : `/api/subtitle-proxy?url=${encodeURIComponent(rawSubUrl)}`;
          const res = await fetch(proxiedUrl);
          if (res.ok) {
            const rawText = await res.text();
            if (rawText && !isCancelled) {
              const parsed: ParsedSubtitleCue[] = [];
              const blocks = rawText.replace(/^\uFEFF/, '').split(/\r?\n\s*\r?\n/);
              for (const block of blocks) {
                const lines = block.trim().split(/\r?\n/).filter(Boolean);
                const timeLineIndex = lines.findIndex((l) => l.includes('-->'));
                if (timeLineIndex === -1) continue;
                const timeLine = lines[timeLineIndex];
                const arrowIdx = timeLine.indexOf('-->');
                const startToken = timeLine.slice(0, arrowIdx).trim().split(/\s+/).pop() || '';
                const endToken = timeLine.slice(arrowIdx + 3).trim().split(/\s+/)[0] || '';
                const startSeconds = parseSubTimestamp(startToken);
                if (startSeconds === null) continue;
                const parsedEnd = parseSubTimestamp(endToken);
                const endSeconds =
                  parsedEnd !== null && parsedEnd > startSeconds ? parsedEnd : startSeconds + 4;

                const wholeSecs = Math.floor(startSeconds);
                const formattedTime = `${String(Math.floor(wholeSecs / 60)).padStart(2, '0')}:${String(
                  wholeSecs % 60
                ).padStart(2, '0')}`;
                const textLines = lines.slice(timeLineIndex + 1);
                const cleanText = textLines
                  .join('\n')
                  .replace(/\\N/g, '\n')
                  .replace(/\{\\[^}]*\}/g, '')
                  .replace(/<br\s*\/?>/gi, '\n')
                  .replace(/<[^>]*>/g, '')
                  .replace(/&amp;/g, '&')
                  .replace(/&lt;/g, '<')
                  .replace(/&gt;/g, '>')
                  .replace(/&quot;/g, '"')
                  .replace(/&#39;/g, "'")
                  .replace(/&nbsp;/g, ' ')
                  .trim();
                if (cleanText) {
                  parsed.push({
                    id: `cue-${startSeconds.toFixed(3)}-${parsed.length}`,
                    startSeconds,
                    endSeconds,
                    formattedTime,
                    text: cleanText,
                  });
                }
              }

              if (parsed.length > 0) {
                parsed.sort((a, b) => a.startSeconds - b.startSeconds);
                setParsedSubtitleCues(parsed);
                setIsLoadingSubCues(false);
                return;
              }
            }
          }
        } catch {
          // Real subtitle track failed to load
        }
      }

      if (!isCancelled) {
        setParsedSubtitleCues([]);
        setIsLoadingSubCues(false);
      }
    }

    loadSubtitleCues();

    return () => {
      isCancelled = true;
    };
  }, [streamData?.subtitles, selectedSubtitle, activeVideoEpisode?.media?.id, activeVideoEpisode?.episodeNumber]);

  const [streamError, setStreamError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [liveEpisodes, setLiveEpisodes] = useState<EpisodeItem[]>([]);

  // Keep saved timestamp in sync
  useEffect(() => {
    savedTimestampRef.current = currentTime;
  }, [currentTime]);

  const captureCurrentVideoFrame = useCallback((): string | undefined => {
    const video = videoRef.current;
    if (!video || video.readyState < 2 || video.videoWidth <= 0 || video.videoHeight <= 0) {
      return lastCapturedFrameRef.current;
    }
    try {
      const maxW = 480;
      const scale = Math.min(1, maxW / video.videoWidth);
      const w = Math.max(1, Math.round(video.videoWidth * scale));
      const h = Math.max(1, Math.round(video.videoHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return lastCapturedFrameRef.current;
      ctx.drawImage(video, 0, 0, w, h);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.72);
      if (dataUrl && dataUrl.startsWith('data:image/')) {
        lastCapturedFrameRef.current = dataUrl;
        return dataUrl;
      }
    } catch {
      // Ignore cross-origin canvas errors on unproxied streams
    }
    return lastCapturedFrameRef.current;
  }, []);

  // Sync initial timestamp & reset user pause state when episode changes
  useEffect(() => {
    userPausedRef.current = false;
    pendingResumeTimeRef.current = null;
    lastCapturedFrameRef.current = undefined;
    setIsBuffering(false);
    setBufferedTime(0);
    setUpNextCountdown(null);
    setIsHoldSpeed2x(false);
    setActiveAutoHeight(null);
    setSubDelayMs(0);
    setTempSubDelayMs(0);
    if (activeVideoEpisode?.initialTime && activeVideoEpisode.initialTime > 0) {
      savedTimestampRef.current = activeVideoEpisode.initialTime;
      setCurrentTime(activeVideoEpisode.initialTime);
      setLiveSubTime(activeVideoEpisode.initialTime);
      hasAppliedInitialSeekRef.current = false;
    } else {
      savedTimestampRef.current = 0;
      setCurrentTime(0);
      setLiveSubTime(0);
      hasAppliedInitialSeekRef.current = false;
    }
  }, [activeVideoEpisode?.media?.id, activeVideoEpisode?.episodeNumber, activeVideoEpisode?.initialTime]);

  // Update library progress & anime watch history when opening episode
  useEffect(() => {
    if (activeVideoEpisode) {
      updateLibraryProgress(activeVideoEpisode.media.id, activeVideoEpisode.episodeNumber);
      const effectiveTime = currentTime > 0 ? currentTime : (activeVideoEpisode.initialTime || 0);
      recordAnimeWatchProgress(
        activeVideoEpisode.media,
        activeVideoEpisode.episodeNumber,
        effectiveTime,
        duration
      );
    }
  }, [activeVideoEpisode?.media.id, activeVideoEpisode?.episodeNumber]);

  // Save latest watch progress & last frame on component unmount
  useEffect(() => {
    return () => {
      if (activeVideoEpisode && (savedTimestampRef.current > 0 || lastCapturedFrameRef.current)) {
        recordAnimeWatchProgress(
          activeVideoEpisode.media,
          activeVideoEpisode.episodeNumber,
          savedTimestampRef.current,
          duration,
          lastCapturedFrameRef.current
        );
      }
    };
  }, [activeVideoEpisode, duration]);

  // Load real aired episodes
  useEffect(() => {
    let isCancelled = false;
    async function loadEpisodes() {
      if (!activeVideoEpisode?.media) return;
      try {
        const eps = await fetchMediaEpisodes(activeVideoEpisode.media);
        if (!isCancelled && eps.length > 0) {
          setLiveEpisodes(eps);
        }
      } catch (err) {
        console.warn('Failed to fetch aired episodes:', err);
      }
    }
    loadEpisodes();
    return () => {
      isCancelled = true;
    };
  }, [activeVideoEpisode?.media?.id]);

  // Auto-request landscape fullscreen on open
  useEffect(() => {
    const triggerLandscapeMode = async () => {
      try {
        if (containerRef.current && !document.fullscreenElement) {
          await containerRef.current.requestFullscreen().catch(() => {});
        }
        if (window.screen && 'orientation' in window.screen) {
          const orientation = window.screen.orientation as any;
          if (orientation && typeof orientation.lock === 'function') {
            await orientation.lock('landscape').catch(() => {});
          }
        }
      } catch {
        // Safe fallback
      }
    };

    triggerLandscapeMode();

    return () => {
      try {
        if (window.screen && 'orientation' in window.screen) {
          const orientation = window.screen.orientation as any;
          if (orientation && typeof orientation.unlock === 'function') {
            orientation.unlock();
          }
        }
      } catch {}
    };
  }, []);

  const extractRealSourceQualities = useCallback((sources: VideoStreamSource[]): string[] => {
    const VALID_HEIGHTS = new Set([144, 240, 360, 480, 540, 720, 1080, 1440, 2160]);
    const result = new Set<string>();
    for (const s of sources) {
      const raw = String(s?.quality || '').trim();
      if (!raw) continue;
      const resMatch = raw.match(/(?:^|\D)(2160|1440|1080|720|540|480|360|240|144)p?(?:\D|$)/i);
      if (resMatch) {
        const h = parseInt(resMatch[1], 10);
        if (VALID_HEIGHTS.has(h)) {
          result.add(`${h}p`);
        }
      } else if (/^\s*4k\s*$/i.test(raw)) {
        result.add('2160p');
      }
    }
    return Array.from(result);
  }, []);

  const buildRealQualitiesList = useCallback(
    (sources: VideoStreamSource[], manifestHeights: number[] = []): string[] => {
      const fromSources = extractRealSourceQualities(sources);
      const fromManifest = manifestHeights
        .filter((h) => Number.isFinite(h) && h >= 144)
        .map((h) => `${h}p`);
      const merged = Array.from(new Set([...fromManifest, ...fromSources])).sort((a, b) => {
        const na = parseInt(a.replace(/[^0-9]/g, ''), 10) || 0;
        const nb = parseInt(b.replace(/[^0-9]/g, ''), 10) || 0;
        return nb - na;
      });
      return ['Auto (HLS)', ...merged];
    },
    [extractRealSourceQualities]
  );

  const getAltTitles = useCallback(() => {
    const m = activeVideoEpisode?.media;
    if (!m) return [];
    return [m.englishTitle, m.romajiTitle, m.nativeTitle, ...(m.synonyms || [])]
      .map((t) => String(t || '').trim())
      .filter((t) => Boolean(t) && t !== m.title);
  }, [activeVideoEpisode?.media]);

  // Keep browser-native textTracks disabled so only our custom live subtitle overlay renders
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !video.textTracks) return;
    Array.from(video.textTracks).forEach((t) => {
      if (t.mode !== 'disabled') {
        t.mode = 'disabled';
      }
    });
  }, [selectedSubtitle, streamData?.subtitles]);

  // High-frequency (~50ms) playback timestamp ticker for millisecond-accurate live custom subtitles & SubDelay sync
  useEffect(() => {
    if (!isPlaying || isBuffering || selectedSubtitle === 'Off' || parsedSubtitleCues.length === 0) {
      return;
    }
    const timer = setInterval(() => {
      if (videoRef.current && !isScrubbingRef.current) {
        setLiveSubTime(videoRef.current.currentTime);
      }
    }, 50);
    return () => clearInterval(timer);
  }, [isPlaying, isBuffering, selectedSubtitle, parsedSubtitleCues.length]);

  // Background prefetch + pre-buffer next episode at ~85% playback so switching has zero loading delay
  useEffect(() => {
    if (!activeVideoEpisode || duration <= 0) return;
    const progressRatio = currentTime / duration;
    if (progressRatio < 0.85) return;

    const maxEp =
      liveEpisodes.length > 0
        ? Math.max(...liveEpisodes.map((e) => e.number))
        : activeVideoEpisode.media.latestEpisode || activeVideoEpisode.media.totalEpisodes || 24;

    if (activeVideoEpisode.episodeNumber >= maxEp) return;

    const nextEp = activeVideoEpisode.episodeNumber + 1;
    const nextKey = `${activeVideoEpisode.media.id}:${nextEp}:${audioTrack}`;
    if (prefetchedAttemptKeyRef.current === nextKey) return;

    prefetchedAttemptKeyRef.current = nextKey;
    prefetchAbortRef.current?.abort();
    const controller = new AbortController();
    prefetchAbortRef.current = controller;

    const resolveAbsoluteUrl = (rawLine: string, baseUrl: string): string => {
      try {
        const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
        const resolvedBase = new URL(baseUrl, origin);
        return new URL(rawLine, resolvedBase).toString();
      } catch {
        return rawLine;
      }
    };

    const prewarmNextEpisodeAssets = async (payload: ResolvedStreamPayload) => {
      try {
        const manifest = payload.servers?.[payload.activeServer] || payload.servers?.anikoto;
        const primarySource = (manifest?.sources || payload.sources || [])[0];
        if (!primarySource?.url || controller.signal.aborted) return;

        if (primarySource.isM3U8 || primarySource.url.includes('.m3u8')) {
          const masterRes = await fetch(primarySource.url, { signal: controller.signal });
          if (!masterRes.ok || controller.signal.aborted) return;
          const playlistText = await masterRes.text();
          const lines = playlistText
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l.length > 0 && !l.startsWith('#'));

          let mediaPlaylistText = playlistText;
          let mediaPlaylistUrl = primarySource.url;

          const subPlaylistLine = lines.find((l) => l.includes('.m3u8'));
          if (subPlaylistLine) {
            mediaPlaylistUrl = resolveAbsoluteUrl(subPlaylistLine, primarySource.url);
            const mediaRes = await fetch(mediaPlaylistUrl, { signal: controller.signal });
            if (mediaRes.ok && !controller.signal.aborted) {
              mediaPlaylistText = await mediaRes.text();
            }
          }

          // Pre-buffer the first 2 media segments into browser/proxy cache
          const segmentLines = mediaPlaylistText
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l.length > 0 && !l.startsWith('#') && !l.includes('.m3u8'))
            .slice(0, 2);

          for (const seg of segmentLines) {
            if (controller.signal.aborted) break;
            const segUrl = resolveAbsoluteUrl(seg, mediaPlaylistUrl);
            await fetch(segUrl, { signal: controller.signal }).catch(() => {});
          }
        } else {
          // Direct MP4 initial range warm-up
          await fetch(primarySource.url, {
            signal: controller.signal,
            headers: { Range: 'bytes=0-1048575' },
          }).catch(() => {});
        }

        // Pre-warm primary subtitle track if available
        const firstSubUrl = payload.subtitles?.[0]?.url?.trim();
        if (firstSubUrl && !controller.signal.aborted) {
          const proxiedSub = firstSubUrl.startsWith('/api/subtitle-proxy')
            ? firstSubUrl
            : `/api/subtitle-proxy?url=${encodeURIComponent(firstSubUrl)}`;
          await fetch(proxiedSub, { signal: controller.signal }).catch(() => {});
        }
      } catch {
        // Silent best-effort background prefetch
      }
    };

    const promise = resolveStreamWithFallbacks(
      activeVideoEpisode.media.id,
      nextEp,
      activeVideoEpisode.media.title,
      audioTrack,
      selectedServer,
      getAltTitles(),
      false
    )
      .then((data) => {
        if (controller.signal.aborted || !data?.success) return null;
        const manifest = data.servers?.[data.activeServer] || data.servers?.anikoto;
        const hasSources = (manifest?.sources?.length || data.sources?.length || 0) > 0;
        if (!hasSources) return null;

        prefetchedNextRef.current = { key: nextKey, data };
        void prewarmNextEpisodeAssets(data);
        return data;
      })
      .catch(() => null);

    prefetchedPromiseRef.current = { key: nextKey, promise };
  }, [
    currentTime,
    duration,
    activeVideoEpisode?.media?.id,
    activeVideoEpisode?.media?.title,
    activeVideoEpisode?.media?.latestEpisode,
    activeVideoEpisode?.media?.totalEpisodes,
    activeVideoEpisode?.episodeNumber,
    audioTrack,
    selectedServer,
    liveEpisodes,
    getAltTitles,
  ]);

  // Abort any unrelated background prefetch on unmount or media change
  useEffect(() => {
    return () => {
      prefetchAbortRef.current?.abort();
    };
  }, [activeVideoEpisode?.media?.id, audioTrack]);

  // Fetch stream sources starting with Primary (Anikoto) and falling back sequentially 1..4 (uses 85% prefetch cache when ready)
  useEffect(() => {
    let isCancelled = false;

    async function loadStream() {
      if (!activeVideoEpisode) return;
      const currentKey = `${activeVideoEpisode.media.id}:${activeVideoEpisode.episodeNumber}:${audioTrack}`;
      const cachedHit = prefetchedNextRef.current?.key === currentKey ? prefetchedNextRef.current.data : null;

      if (!cachedHit) {
        setIsLoadingStream(true);
      } else {
        setIsLoadingStream(false);
      }
      setStreamError(null);
      setActiveSourceIndex(0);
      failedServersRef.current = new Set();

      try {
        let data: ResolvedStreamPayload | null = cachedHit;
        if (!data && prefetchedPromiseRef.current?.key === currentKey) {
          data = await prefetchedPromiseRef.current.promise;
        }
        if (!data) {
          data = await resolveStreamWithFallbacks(
            activeVideoEpisode.media.id,
            activeVideoEpisode.episodeNumber,
            activeVideoEpisode.media.title,
            audioTrack,
            'anikoto',
            getAltTitles(),
            false
          );
        }

        if (isCancelled) return;

        if (data && data.servers) {
          setStreamData(data);
          const resolvedKey = data.activeServer || 'anikoto';
          setSelectedServer(resolvedKey);

          const currentManifest = data.servers[resolvedKey] || data.servers.anikoto;
          const currentSources = currentManifest?.sources || data.sources;

          if (currentSources.length === 0) {
            const srvName = SERVER_METADATA[resolvedKey]?.name || 'Anikoto';
            setStreamError(`No stream found on ${srvName} or fallback sources for this episode.`);
          } else if (resolvedKey !== 'anikoto' && !cachedHit) {
            showToast(`Loaded via ${SERVER_METADATA[resolvedKey].name} (${SERVER_METADATA[resolvedKey].tag})`);
          }

          const realQualities = buildRealQualitiesList(currentSources);
          setAvailableQualities(realQualities);
          if (!realQualities.includes(selectedQualityRef.current)) {
            setSelectedQuality('Auto (HLS)');
            selectedQualityRef.current = 'Auto (HLS)';
          }
        } else {
          setStreamError('No playable stream found for this episode.');
        }
      } catch (err: any) {
        if (!isCancelled) {
          setStreamError(err?.message || 'Failed to load anime stream.');
        }
      } finally {
        if (!isCancelled) {
          setIsLoadingStream(false);
        }
      }
    }

    loadStream();

    return () => {
      isCancelled = true;
    };
  }, [activeVideoEpisode?.media?.id, activeVideoEpisode?.episodeNumber, audioTrack, retryCount, getAltTitles]);

  // Automatic sequential failover across Primary -> Fallback 1..4 on runtime HLS error
  const triggerAutoFailover = useCallback(
    async (reason: string) => {
      const currentPos = videoRef.current ? videoRef.current.currentTime : savedTimestampRef.current;
      savedTimestampRef.current = currentPos;

      if (stallTimerRef.current) {
        clearTimeout(stallTimerRef.current);
        stallTimerRef.current = null;
      }
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }

      failedServersRef.current.add(selectedServer);
      const nextServer = ANIME_SERVER_ORDER.find((s) => !failedServersRef.current.has(s));

      if (!nextServer || !activeVideoEpisode) {
        setStreamError(reason || 'Stream playback failed across all sources.');
        showToast('All anime sources unavailable');
        return;
      }

      const nextMeta = SERVER_METADATA[nextServer];
      showToast(`Switching to ${nextMeta.name} (${nextMeta.tag})...`);

      const existingSources = streamData?.servers?.[nextServer]?.sources;
      if (existingSources && existingSources.length > 0) {
        const realQ = buildRealQualitiesList(existingSources);
        setAvailableQualities(realQ);
        setActiveAutoHeight(null);
        if (!realQ.includes(selectedQualityRef.current)) {
          setSelectedQuality('Auto (HLS)');
          selectedQualityRef.current = 'Auto (HLS)';
        }
        setActiveSourceIndex(0);
        setSelectedServer(nextServer);
        setStreamError(null);
        return;
      }

      setIsLoadingStream(true);
      try {
        const res = await resolveStreamWithFallbacks(
          activeVideoEpisode.media.id,
          activeVideoEpisode.episodeNumber,
          activeVideoEpisode.media.title,
          audioTrack,
          nextServer,
          getAltTitles(),
          true
        );

        if (res.success && res.sources.length > 0) {
          const srvSources = res.servers[nextServer]?.sources || res.sources;
          const realQ = buildRealQualitiesList(srvSources);
          setAvailableQualities(realQ);
          setActiveAutoHeight(null);
          if (!realQ.includes(selectedQualityRef.current)) {
            setSelectedQuality('Auto (HLS)');
            selectedQualityRef.current = 'Auto (HLS)';
          }
          setStreamData((prev) => ({
            ...(prev || res),
            success: true,
            activeServer: nextServer,
            sources: res.sources,
            subtitles: res.subtitles?.length ? res.subtitles : prev?.subtitles || [],
            intro: res.intro || prev?.intro,
            outro: res.outro || prev?.outro,
            servers: {
              ...(prev?.servers || res.servers),
              [nextServer]: res.servers[nextServer],
            },
          }));
          setActiveSourceIndex(0);
          setSelectedServer(nextServer);
          setStreamError(null);
        } else {
          // Continue cascading to next fallback
          failedServersRef.current.add(nextServer);
          const remainingServer = ANIME_SERVER_ORDER.find((s) => !failedServersRef.current.has(s));
          if (remainingServer) {
            const cascade = await resolveStreamWithFallbacks(
              activeVideoEpisode.media.id,
              activeVideoEpisode.episodeNumber,
              activeVideoEpisode.media.title,
              audioTrack,
              remainingServer,
              getAltTitles(),
              false
            );
            if (cascade.success && cascade.sources.length > 0) {
              const cascadeSources = cascade.servers[cascade.activeServer]?.sources || cascade.sources;
              const realQ = buildRealQualitiesList(cascadeSources);
              setAvailableQualities(realQ);
              setActiveAutoHeight(null);
              if (!realQ.includes(selectedQualityRef.current)) {
                setSelectedQuality('Auto (HLS)');
                selectedQualityRef.current = 'Auto (HLS)';
              }
              setStreamData((prev) => ({
                ...(prev || cascade),
                success: true,
                activeServer: cascade.activeServer,
                sources: cascade.sources,
                subtitles: cascade.subtitles?.length ? cascade.subtitles : prev?.subtitles || [],
                intro: cascade.intro || prev?.intro,
                outro: cascade.outro || prev?.outro,
                servers: {
                  ...(prev?.servers || cascade.servers),
                  ...cascade.servers,
                },
              }));
              setActiveSourceIndex(0);
              setSelectedServer(cascade.activeServer);
              setStreamError(null);
            } else {
              setStreamError(reason || 'Stream playback failed across all fallback sources.');
            }
          } else {
            setStreamError(reason || 'Stream playback failed across all fallback sources.');
          }
        }
      } catch {
        setStreamError(reason || 'Stream failover failed.');
      } finally {
        setIsLoadingStream(false);
      }
    },
    [selectedServer, activeVideoEpisode, streamData, audioTrack, getAltTitles, buildRealQualitiesList, showToast]
  );

  // Manual Server Refresh / Selection Handler
  const handleServerSelect = async (serverKey: AnimeStreamServer) => {
    const meta = SERVER_METADATA[serverKey];
    const currentPos = videoRef.current ? videoRef.current.currentTime : savedTimestampRef.current;
    savedTimestampRef.current = currentPos;

    setSelectedServer(serverKey);
    setActiveSourceIndex(0);
    setStreamError(null);

    const existingSources = streamData?.servers?.[serverKey]?.sources;
    if (existingSources && existingSources.length > 0) {
      const realQ = buildRealQualitiesList(existingSources);
      setAvailableQualities(realQ);
      setActiveAutoHeight(null);
      if (!realQ.includes(selectedQualityRef.current)) {
        setSelectedQuality('Auto (HLS)');
        selectedQualityRef.current = 'Auto (HLS)';
      }
      showToast(`Active Server: ${meta.name} (${meta.tag})`);
      return;
    }

    if (!activeVideoEpisode) return;
    setIsLoadingStream(true);
    showToast(`Loading ${meta.name} (${meta.tag})...`);

    try {
      const res = await resolveStreamWithFallbacks(
        activeVideoEpisode.media.id,
        activeVideoEpisode.episodeNumber,
        activeVideoEpisode.media.title,
        audioTrack,
        serverKey,
        getAltTitles(),
        true
      );
      if (res.success && res.sources.length > 0) {
        const srvSources = res.servers[serverKey]?.sources || res.sources;
        const realQ = buildRealQualitiesList(srvSources);
        setAvailableQualities(realQ);
        setActiveAutoHeight(null);
        if (!realQ.includes(selectedQualityRef.current)) {
          setSelectedQuality('Auto (HLS)');
          selectedQualityRef.current = 'Auto (HLS)';
        }
        setStreamData((prev) => ({
          ...(prev || res),
          success: true,
          activeServer: serverKey,
          sources: res.sources,
          subtitles: res.subtitles?.length ? res.subtitles : prev?.subtitles || [],
          intro: res.intro || prev?.intro,
          outro: res.outro || prev?.outro,
          servers: {
            ...(prev?.servers || res.servers),
            [serverKey]: res.servers[serverKey],
          },
        }));
        showToast(`Active Server: ${meta.name} (${meta.tag})`);
      } else {
        setStreamError(`No stream found on ${meta.name} for this episode.`);
        showToast(`${meta.name} unavailable for this episode`);
      }
    } catch {
      setStreamError(`Failed to load ${meta.name}.`);
    } finally {
      setIsLoadingStream(false);
    }
  };

  useEffect(() => {
    triggerAutoFailoverRef.current = triggerAutoFailover;
  }, [triggerAutoFailover]);

  useEffect(() => {
    selectedQualityRef.current = selectedQuality;
  }, [selectedQuality]);

  // Helper to update buffered timeline range from HTMLMediaElement
  const updateBufferedRange = useCallback(() => {
    const video = videoRef.current;
    if (!video || !video.buffered || video.buffered.length === 0) return;
    const t = video.currentTime || 0;
    let maxEnd = 0;
    for (let i = 0; i < video.buffered.length; i++) {
      const start = video.buffered.start(i);
      const end = video.buffered.end(i);
      if (t >= start - 0.5 && t <= end + 0.5) {
        maxEnd = Math.max(maxEnd, end);
      } else if (end > maxEnd) {
        maxEnd = end;
      }
    }
    setBufferedTime(maxEnd);
  }, []);

  // Mount video source and initialize HLS.js engine with production VOD buffering
  useEffect(() => {
    if (!videoRef.current || !streamData) return;

    const video = videoRef.current;
    const currentManifest = streamData.servers[selectedServer] || streamData.servers[streamData.activeServer];
    const currentSources = currentManifest?.sources || streamData.sources || [];

    if (currentSources.length === 0) return;

    const safeIndex = Math.min(activeSourceIndex, currentSources.length - 1);
    const activeQuality = selectedQualityRef.current;
    const cleanSelectedQ = activeQuality.toLowerCase().replace(/[^0-9]/g, '');
    const matchingSource =
      activeQuality !== 'Auto (HLS)' && cleanSelectedQ
        ? currentSources.find((s) => s.quality?.toLowerCase().replace(/[^0-9]/g, '') === cleanSelectedQ)
        : null;

    const activeSource: VideoStreamSource = matchingSource || currentSources[safeIndex] || currentSources[0];
    const streamUrl = activeSource.url;

    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    const targetResumeTime =
      pendingResumeTimeRef.current ?? savedTimestampRef.current ?? activeVideoEpisode?.initialTime ?? 0;

    const restoreTimestamp = () => {
      const targetTime =
        pendingResumeTimeRef.current ?? savedTimestampRef.current ?? activeVideoEpisode?.initialTime ?? 0;
      if (targetTime > 0 && video) {
        try {
          video.currentTime = targetTime;
          setCurrentTime(targetTime);
          hasAppliedInitialSeekRef.current = true;
        } catch {}
      }
    };

    const startPlaybackIfAllowed = () => {
      if (userPausedRef.current) {
        video.pause();
        setIsPlaying(false);
        return;
      }
      video.play()
        .then(() => {
          if (userPausedRef.current) {
            video.pause();
            setIsPlaying(false);
          } else {
            setIsPlaying(true);
          }
        })
        .catch(() => {
          setIsPlaying(false);
        });
    };

    if (Hls.isSupported() && (activeSource.isM3U8 || streamUrl.includes('.m3u8'))) {
      let mediaRecoveryAttempts = 0;
      let networkRecoveryAttempts = 0;

      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false, // Production VOD mode: prevents aggressive drops & micro-stutters
        startFragPrefetch: true, // Prefetch next segment immediately for continuous playback
        startPosition: targetResumeTime > 0 ? targetResumeTime : -1,
        startLevel: -1, // Adaptive start level when Auto is active
        testBandwidth: true, // Probe bandwidth cleanly before upshifting to 1080p
        backBufferLength: 30,
        maxBufferLength: 60, // Maintain 60s forward buffer ahead of playhead
        maxMaxBufferLength: 180, // Allow up to 3 minutes pre-buffered on fast connections
        maxBufferSize: 120 * 1000 * 1000, // 120MB video buffer ceiling
        maxBufferHole: 0.5, // Skip small timestamp gaps automatically instead of freezing
        nudgeOffset: 0.2,
        nudgeMaxRetry: 10,
        highBufferWatchdogPeriod: 2,
        abrEwmaDefaultEstimate: 650_000, // Conservative 650kbps initial estimate -> fast 2-6s start in 360p/480p/720p on weak nets, then climbs to 1080p
        abrEwmaFastLive: 3.0,
        abrEwmaSlowLive: 9.0,
        abrEwmaFastVoD: 2.0,
        abrEwmaSlowVoD: 5.0,
        abrBandWidthFactor: 0.85,
        abrBandWidthUpFactor: 0.75,
        minAutoBitrate: 0,
        capLevelToPlayerSize: false,
        capLevelOnFPSDrop: false,
        manifestLoadingTimeOut: 20_000,
        manifestLoadingMaxRetry: 4,
        manifestLoadingRetryDelay: 800,
        levelLoadingTimeOut: 20_000,
        levelLoadingMaxRetry: 4,
        levelLoadingRetryDelay: 800,
        fragLoadingTimeOut: 30_000,
        fragLoadingMaxRetry: 6,
        fragLoadingRetryDelay: 800,
        fragLoadingMaxRetryTimeout: 16_000,
        xhrSetup: (xhr) => {
          xhr.withCredentials = false;
        },
      });

      hls.loadSource(streamUrl);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
        if (data.levels && data.levels.length > 0) {
          const realQualities = buildRealQualitiesList(
            currentSources,
            data.levels.map((lvl) => lvl.height)
          );
          setAvailableQualities(realQualities);

          const currQ = selectedQualityRef.current;
          if (currQ.includes('Auto')) {
            hls.autoLevelCapping = -1;
            hls.currentLevel = -1;
            hls.nextLevel = -1;
            hls.loadLevel = -1;
          } else {
            const targetHeight = parseInt(currQ.replace(/[^0-9]/g, ''), 10);
            const targetLevelIndex = targetHeight
              ? data.levels.findIndex((lvl) => lvl.height === targetHeight)
              : -1;
            if (targetLevelIndex !== -1) {
              // Strictly lock to the user's dedicated quality (no ABR switching)
              hls.currentLevel = targetLevelIndex;
              hls.nextLevel = targetLevelIndex;
              hls.loadLevel = targetLevelIndex;
            } else if (!realQualities.includes(currQ)) {
              setSelectedQuality('Auto (HLS)');
              selectedQualityRef.current = 'Auto (HLS)';
              hls.autoLevelCapping = -1;
              hls.currentLevel = -1;
              hls.nextLevel = -1;
              hls.loadLevel = -1;
            }
          }
        } else {
          setAvailableQualities(buildRealQualitiesList(currentSources));
        }

        restoreTimestamp();
        startPlaybackIfAllowed();
      });

      hls.on(Hls.Events.LEVEL_SWITCHED, (_, data) => {
        const lvl = hls.levels?.[data.level];
        setActiveAutoHeight(lvl?.height && lvl.height >= 144 ? lvl.height : null);
      });

      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        updateBufferedRange();
        setIsBuffering(false);
        if (selectedQualityRef.current.includes('Auto') && hls.levels && hls.levels.length > 1) {
          hls.autoLevelCapping = -1;
          hls.nextLevel = -1;
        }
      });

      hls.on(Hls.Events.ERROR, (_, data) => {
        if (!data.fatal) {
          // Silently nudge past non-fatal buffer stall errors
          if (data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR && !userPausedRef.current) {
            setIsBuffering(true);
            hls.startLoad();
          }
          return;
        }

        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            networkRecoveryAttempts += 1;
            if (
              networkRecoveryAttempts <= 2 &&
              !(data.response?.code !== undefined && data.response.code >= 400 && data.response.code !== 408 && data.response.code !== 429)
            ) {
              hls.startLoad();
            } else {
              triggerAutoFailoverRef.current(`Network HTTP ${data.response?.code || 'Error'}`);
            }
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            mediaRecoveryAttempts += 1;
            if (mediaRecoveryAttempts <= 2) {
              hls.recoverMediaError();
              if (userPausedRef.current) {
                setTimeout(() => video.pause(), 50);
              }
            } else {
              triggerAutoFailoverRef.current('Media decode error');
            }
            break;
          default:
            hls.destroy();
            triggerAutoFailoverRef.current('Unrecoverable stream error');
            break;
        }
      });

      hlsRef.current = hls;
    } else if (video.canPlayType('application/vnd.apple.mpegurl') || !streamUrl.includes('.m3u8')) {
      video.src = streamUrl;
      restoreTimestamp();
      video.onerror = () => {
        triggerAutoFailoverRef.current('Native video playback error');
      };
      startPlaybackIfAllowed();
    }

    return () => {
      if (stallTimerRef.current) {
        clearTimeout(stallTimerRef.current);
        stallTimerRef.current = null;
      }
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [streamData, selectedServer, activeSourceIndex, updateBufferedRange]);

  // Handle dynamic resolution level change: Auto = Adaptive ABR, Dedicated = Strict Locked Level
  const handleQualityChange = (quality: string) => {
    setSelectedQuality(quality);
    selectedQualityRef.current = quality;
    showToast(`Quality: ${quality.replace(' (HLS)', '')}`);

    const currentManifest =
      streamData?.servers[selectedServer] ||
      (streamData?.activeServer ? streamData.servers[streamData.activeServer] : undefined);
    const sources = currentManifest?.sources || streamData?.sources || [];

    if (hlsRef.current && hlsRef.current.levels && hlsRef.current.levels.length > 0) {
      if (quality.includes('Auto')) {
        hlsRef.current.autoLevelCapping = -1;
        hlsRef.current.currentLevel = -1;
        hlsRef.current.nextLevel = -1;
        hlsRef.current.loadLevel = -1;
        if (sources.length > 1 && activeSourceIndex !== 0) {
          savedTimestampRef.current = videoRef.current ? videoRef.current.currentTime : currentTime;
          setActiveSourceIndex(0);
        }
        return;
      } else {
        const targetHeight = parseInt(quality.replace(/[^0-9]/g, ''), 10);
        const levelIdx = targetHeight
          ? hlsRef.current.levels.findIndex((lvl) => lvl.height === targetHeight)
          : -1;
        if (levelIdx !== -1) {
          // Strictly lock dedicated quality (disables ABR auto-switching)
          hlsRef.current.currentLevel = levelIdx;
          hlsRef.current.nextLevel = levelIdx;
          hlsRef.current.loadLevel = levelIdx;
          return;
        }
      }
    }

    // Switch manifest source index if the server returned separate per-quality manifest URLs
    if (quality.includes('Auto') && sources.length > 1 && activeSourceIndex !== 0) {
      savedTimestampRef.current = videoRef.current ? videoRef.current.currentTime : currentTime;
      setActiveSourceIndex(0);
      return;
    }

    const cleanQ = quality.toLowerCase().replace(/[^0-9]/g, '');
    if (cleanQ && sources.length > 1) {
      const idx = sources.findIndex((s) => s.quality?.toLowerCase().replace(/[^0-9]/g, '') === cleanQ);
      if (idx !== -1 && idx !== activeSourceIndex) {
        savedTimestampRef.current = videoRef.current ? videoRef.current.currentTime : currentTime;
        setActiveSourceIndex(idx);
      }
    }
  };

  // Sync volume, mute & speed (including temporary hold-for-2x gesture) to video element
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.volume = volume;
      videoRef.current.muted = isMuted;
      const baseSpeed = parseFloat(playbackSpeed.replace('x', '')) || 1.0;
      videoRef.current.playbackRate = isHoldSpeed2x ? 2.0 : baseSpeed;
    }
  }, [volume, isMuted, playbackSpeed, isHoldSpeed2x]);

  // Fullscreen change listener
  useEffect(() => {
    const handleFsChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', handleFsChange);
    return () => document.removeEventListener('fullscreenchange', handleFsChange);
  }, []);

  // Controls auto-hide timer (3 seconds of inactivity)
  const resetControlsTimer = useCallback(() => {
    setShowControls(true);
    if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    controlsTimeoutRef.current = setTimeout(() => {
      // Auto-hide controls overlay after 3 seconds of inactivity
      if (!activeDrawer && !isLocked && !isScrubbingRef.current) {
        setShowControls(false);
      }
    }, 3000);
  }, [activeDrawer, isLocked]);

  // Start auto-hide timer on mount or episode change
  useEffect(() => {
    resetControlsTimer();
    return () => {
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current);
      }
    };
  }, [resetControlsTimer, activeVideoEpisode?.episodeNumber]);

  // When drawer closes or opens, manage auto-hide timer
  useEffect(() => {
    if (!activeDrawer) {
      resetControlsTimer();
    } else {
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current);
      }
      setShowControls(true);
    }
  }, [activeDrawer, resetControlsTimer]);

  const handleScreenTap = useCallback(() => {
    if (isLocked) {
      if (showUnlockPrompt) {
        setShowUnlockPrompt(false);
        if (unlockPromptTimerRef.current) {
          clearTimeout(unlockPromptTimerRef.current);
          unlockPromptTimerRef.current = null;
        }
      } else {
        setShowUnlockPrompt(true);
        if (unlockPromptTimerRef.current) clearTimeout(unlockPromptTimerRef.current);
        unlockPromptTimerRef.current = setTimeout(() => setShowUnlockPrompt(false), 3000);
      }
      return;
    }

    if (activeDrawer) {
      setActiveDrawer(null);
      resetControlsTimer();
      return;
    }

    // Toggle controls on screen tap: re-appear on tap if hidden, or dismiss if already visible
    if (showControls) {
      setShowControls(false);
      if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    } else {
      resetControlsTimer();
    }
  }, [isLocked, showUnlockPrompt, activeDrawer, showControls, resetControlsTimer]);

  // Cleanly clean up gesture timers on unmount
  useEffect(() => {
    return () => {
      if (singleTapTimerRef.current) clearTimeout(singleTapTimerRef.current);
      if (doubleTapTimerRef.current) clearTimeout(doubleTapTimerRef.current);
      if (swipeHudTimerRef.current) clearTimeout(swipeHudTimerRef.current);
      if (suppressClickTimerRef.current) clearTimeout(suppressClickTimerRef.current);
      if (hold2xTimerRef.current) clearTimeout(hold2xTimerRef.current);
      if (unlockPromptTimerRef.current) clearTimeout(unlockPromptTimerRef.current);
    };
  }, []);

  // Compute local visual coordinates inside player (handles CSS 90deg rotation in portrait landscapeFirst mode)
  const getLocalPlayerCoords = useCallback(
    (clientX: number, clientY: number) => {
      const isPortraitViewport =
        typeof window !== 'undefined' && window.innerHeight > window.innerWidth;
      if (landscapeFirst && isPortraitViewport) {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        return {
          x: clientY,
          y: vw - clientX,
          w: vh,
          h: vw,
        };
      }
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) {
        return {
          x: clientX,
          y: clientY,
          w: typeof window !== 'undefined' ? window.innerWidth : 1,
          h: typeof window !== 'undefined' ? window.innerHeight : 1,
        };
      }
      return {
        x: clientX - rect.left,
        y: clientY - rect.top,
        w: rect.width || 1,
        h: rect.height || 1,
      };
    },
    [landscapeFirst]
  );

  const handlePlayerPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse') {
      lastTouchTimeRef.current = Date.now();
    }
    if (isLocked || activeDrawer || isLoadingStream || streamError) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest('button, input, a, [data-no-gesture="true"]')) return;

    if (hold2xTimerRef.current) {
      clearTimeout(hold2xTimerRef.current);
      hold2xTimerRef.current = null;
    }

    const coords = getLocalPlayerCoords(e.clientX, e.clientY);
    gestureRef.current = {
      pointerId: e.pointerId,
      startVisualX: coords.x,
      startVisualY: coords.y,
      visualW: coords.w,
      visualH: coords.h,
      side: coords.x < coords.w / 2 ? 'left' : 'right',
      startBrightness: brightnessRef.current,
      startVolume: isMutedRef.current ? 0 : volumeRef.current,
      mode: 'pending',
      moved: false,
    };

    const activePointerId = e.pointerId;
    const isActivelyPlaying =
      Boolean(videoRef.current) &&
      !videoRef.current!.paused &&
      !videoRef.current!.ended &&
      !userPausedRef.current;

    if (isActivelyPlaying) {
      hold2xTimerRef.current = setTimeout(() => {
        hold2xTimerRef.current = null;
        const g = gestureRef.current;
        const v = videoRef.current;
        if (
          !g ||
          g.pointerId !== activePointerId ||
          g.moved ||
          g.mode !== 'pending' ||
          !v ||
          v.paused ||
          v.ended ||
          userPausedRef.current
        ) {
          return;
        }

        if (singleTapTimerRef.current) {
          clearTimeout(singleTapTimerRef.current);
          singleTapTimerRef.current = null;
        }
        g.mode = 'speed2x';
        setIsHoldSpeed2x(true);
        v.playbackRate = 2.0;
      }, 380);
    }
  };

  const handlePlayerPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    if (!g || g.pointerId !== e.pointerId) return;
    if (g.mode === 'speed2x') return;

    const coords = getLocalPlayerCoords(e.clientX, e.clientY);
    const dx = coords.x - g.startVisualX;
    const dy = coords.y - g.startVisualY;
    const deltaUp = -dy;

    if (Math.hypot(dx, dy) > 8) {
      g.moved = true;
      if (hold2xTimerRef.current) {
        clearTimeout(hold2xTimerRef.current);
        hold2xTimerRef.current = null;
      }
    }

    if (g.mode === 'pending') {
      if (Math.abs(dy) >= 14 && Math.abs(dy) > Math.abs(dx) * 1.15) {
        g.mode = g.side === 'left' ? 'brightness' : 'volume';
        if (swipeHudTimerRef.current) {
          clearTimeout(swipeHudTimerRef.current);
          swipeHudTimerRef.current = null;
        }
      } else if (Math.abs(dx) >= 18 && Math.abs(dx) > Math.abs(dy) * 1.25) {
        g.mode = 'cancelled';
      }
    }

    if (g.mode === 'brightness' || g.mode === 'volume') {
      const span = Math.max(160, g.visualH * 0.62);
      const deltaRatio = deltaUp / span;

      if (g.mode === 'brightness') {
        const nextB = Math.min(1, Math.max(0.15, g.startBrightness + deltaRatio * 0.85));
        setBrightness(nextB);
        const pct = Math.round(((nextB - 0.15) / 0.85) * 100);
        setSwipeHud({ type: 'brightness', percent: Math.min(100, Math.max(0, pct)) });
      } else {
        const nextV = Math.min(1, Math.max(0, g.startVolume + deltaRatio));
        setVolume(nextV);
        const mutedNow = nextV <= 0.01;
        setIsMuted(mutedNow);
        if (videoRef.current) {
          videoRef.current.volume = nextV;
          videoRef.current.muted = mutedNow;
        }
        setSwipeHud({ type: 'volume', percent: Math.round(nextV * 100) });
      }
    }
  };

  const handlePlayerPointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    if (hold2xTimerRef.current) {
      clearTimeout(hold2xTimerRef.current);
      hold2xTimerRef.current = null;
    }

    const g = gestureRef.current;
    if (!g || g.pointerId !== e.pointerId) return;
    gestureRef.current = null;

    if (g.mode === 'speed2x') {
      setIsHoldSpeed2x(false);
      if (videoRef.current) {
        videoRef.current.playbackRate = parseFloat(playbackSpeed.replace('x', '')) || 1.0;
      }
      suppressNextClickRef.current = true;
      if (suppressClickTimerRef.current) clearTimeout(suppressClickTimerRef.current);
      suppressClickTimerRef.current = setTimeout(() => {
        suppressNextClickRef.current = false;
      }, 220);
      return;
    }

    if (g.mode === 'brightness' || g.mode === 'volume') {
      suppressNextClickRef.current = true;
      setTimeout(() => {
        suppressNextClickRef.current = false;
      }, 200);
      if (swipeHudTimerRef.current) clearTimeout(swipeHudTimerRef.current);
      swipeHudTimerRef.current = setTimeout(() => {
        setSwipeHud(null);
      }, 700);
      return;
    }

    if (g.moved) {
      suppressNextClickRef.current = true;
      setTimeout(() => {
        suppressNextClickRef.current = false;
      }, 150);
      return;
    }

    // Handle single-tap vs double-tap seek on left/right side
    const relX = g.startVisualX / g.visualW;
    const zone: 'left' | 'center' | 'right' =
      relX < 0.45 ? 'left' : relX > 0.55 ? 'right' : 'center';

    const now = Date.now();
    suppressNextClickRef.current = true;
    if (suppressClickTimerRef.current) clearTimeout(suppressClickTimerRef.current);
    suppressClickTimerRef.current = setTimeout(() => {
      suppressNextClickRef.current = false;
    }, 400);

    const isDoubleTap =
      zone !== 'center' &&
      ((lastTapRef.current &&
        lastTapRef.current.zone === zone &&
        now - lastTapRef.current.time < 300) ||
        activeDoubleTapSideRef.current === zone);

    if (isDoubleTap) {
      // Double-tap detected! Never open/appear overlay controls here.
      if (singleTapTimerRef.current) {
        clearTimeout(singleTapTimerRef.current);
        singleTapTimerRef.current = null;
      }
      lastTapRef.current = { time: now, zone };
      activeDoubleTapSideRef.current = zone;

      const delta = zone === 'left' ? -10 : 10;
      const basePos = videoRef.current ? videoRef.current.currentTime : currentTimeRef.current;
      const maxDur = videoRef.current?.duration || duration || 1440;
      const targetTime = Math.min(Math.max(0, basePos + delta), maxDur);

      setCurrentTime(targetTime);
      setLiveSubTime(targetTime);
      savedTimestampRef.current = targetTime;
      if (duration > 0 && targetTime < duration - 2) {
        setUpNextCountdown(null);
      }
      if (videoRef.current) {
        videoRef.current.currentTime = targetTime;
      }

      setDoubleTapIndicator((prev) => ({
        side: zone,
        seconds: prev && prev.side === zone ? prev.seconds + 10 : 10,
        key: Date.now(),
      }));

      if (doubleTapTimerRef.current) clearTimeout(doubleTapTimerRef.current);
      doubleTapTimerRef.current = setTimeout(() => {
        activeDoubleTapSideRef.current = null;
        setDoubleTapIndicator(null);
      }, 650);
      return;
    }

    // First tap: wait slightly longer than double-tap window (320ms > 300ms) on left/right
    lastTapRef.current = { time: now, zone };
    if (zone === 'center') {
      handleScreenTap();
    } else {
      if (singleTapTimerRef.current) clearTimeout(singleTapTimerRef.current);
      singleTapTimerRef.current = setTimeout(() => {
        singleTapTimerRef.current = null;
        handleScreenTap();
      }, 320);
    }
  };

  const togglePlay = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (isLocked) return;
    if (videoRef.current) {
      if (videoRef.current.paused || userPausedRef.current) {
        userPausedRef.current = false;
        setIsPlaying(true);
        videoRef.current.play().catch(() => {
          setIsPlaying(false);
        });
      } else {
        userPausedRef.current = true;
        setIsBuffering(false);
        if (stallTimerRef.current) {
          clearTimeout(stallTimerRef.current);
          stallTimerRef.current = null;
        }
        videoRef.current.pause();
        setIsPlaying(false);
      }
    } else {
      setIsPlaying((prev) => {
        userPausedRef.current = prev;
        return !prev;
      });
    }
    resetControlsTimer();
  };

  const handleSeek = (newTime: number) => {
    if (isLocked) return;
    setCurrentTime(newTime);
    setLiveSubTime(newTime);
    savedTimestampRef.current = newTime;
    if (duration > 0 && newTime < duration - 2) {
      setUpNextCountdown(null);
    }
    if (videoRef.current) {
      videoRef.current.currentTime = newTime;
    }
    resetControlsTimer();
  };

  const formatTime = (secs: number) => {
    const safeSecs = Math.max(0, isNaN(secs) ? 0 : secs);
    const m = Math.floor(safeSecs / 60);
    const s = Math.floor(safeSecs % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  // Switch Sub <-> Dub seamlessly while preserving & resuming from the exact playback timestamp
  const handleSwitchAudioTrack = useCallback(
    (nextAudio: 'sub' | 'dub') => {
      if (nextAudio === audioTrack) return;
      const exactPos = videoRef.current ? videoRef.current.currentTime : currentTimeRef.current;
      if (exactPos > 0) {
        savedTimestampRef.current = exactPos;
        pendingResumeTimeRef.current = exactPos;
        hasAppliedInitialSeekRef.current = false;
        setCurrentTime(exactPos);
        if (activeVideoEpisode) {
          recordAnimeWatchProgress(
            activeVideoEpisode.media,
            activeVideoEpisode.episodeNumber,
            exactPos,
            duration,
            captureCurrentVideoFrame()
          );
        }
      }
      setAudioTrack(nextAudio);
      showToast(
        exactPos > 1
          ? `Switched to ${nextAudio === 'dub' ? 'English (Dub)' : 'Japanese (Sub)'} • Resuming ${formatTime(exactPos)}`
          : `Switched Audio: ${nextAudio.toUpperCase()}`
      );
    },
    [audioTrack, activeVideoEpisode, duration, recordAnimeWatchProgress, captureCurrentVideoFrame, showToast]
  );

  // Dynamic Opening (Intro) & Ending (Outro) markers
  const currentManifest = streamData?.servers[selectedServer] || (streamData?.activeServer ? streamData.servers[streamData.activeServer] : undefined);
  const activeIntro = currentManifest?.intro || streamData?.intro;
  const activeOutro = currentManifest?.outro || streamData?.outro;

  const isWithinIntro = Boolean(
    activeIntro &&
    activeIntro.start !== undefined &&
    activeIntro.end !== undefined &&
    activeIntro.end > activeIntro.start &&
    currentTime >= activeIntro.start &&
    currentTime < activeIntro.end
  );

  const isWithinOutro = Boolean(
    activeOutro &&
    activeOutro.start !== undefined &&
    activeOutro.end !== undefined &&
    activeOutro.end > activeOutro.start &&
    currentTime >= activeOutro.start &&
    currentTime < activeOutro.end
  );

  // Show Skip Opening / Skip Ending ONLY when Opening or Ending is actively playing!
  const shouldShowSkipButton = isWithinIntro || isWithinOutro;
  const dynamicSkipLabel = isWithinIntro ? 'Skip Opening' : isWithinOutro ? 'Skip Ending' : '';

  const handleDynamicSkip = () => {
    if (isLocked) return;
    if (isWithinIntro && activeIntro) {
      handleSeek(activeIntro.end);
      showToast('Skipped Opening');
    } else if (isWithinOutro && activeOutro) {
      handleSeek(activeOutro.end);
      showToast('Skipped Ending');
    }
  };

  const toggleLock = () => {
    const nextLocked = !isLocked;
    setIsLocked(nextLocked);
    if (unlockPromptTimerRef.current) {
      clearTimeout(unlockPromptTimerRef.current);
      unlockPromptTimerRef.current = null;
    }
    if (nextLocked) {
      setShowControls(false);
      setActiveDrawer(null);
      setShowUnlockPrompt(true);
      unlockPromptTimerRef.current = setTimeout(() => setShowUnlockPrompt(false), 3000);
      showToast('Screen Locked');
    } else {
      setShowControls(true);
      setShowUnlockPrompt(false);
      showToast('Screen Unlocked');
      resetControlsTimer();
    }
  };

  // Toggle ONLY the anime video frame between Normal (object-contain) and Full Screen Fit (object-cover),
  // without altering the app's own browser fullscreen mode.
  const toggleVideoFrameZoom = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    setIsVideoFrameZoomed((prev) => {
      const next = !prev;
      showToast(next ? 'Video Frame: Full Screen' : 'Video Frame: Normal');
      return next;
    });
    resetControlsTimer();
  };

  const toggleLandscapeRotation = () => {
    setLandscapeFirst((prev) => !prev);
    showToast(landscapeFirst ? 'Portrait Mode' : 'Landscape-First Mode');
  };

  const playNextEpisodeNow = useCallback(() => {
    if (!activeVideoEpisode) return;
    const maxEp =
      liveEpisodes.length > 0
        ? Math.max(...liveEpisodes.map((e) => e.number))
        : activeVideoEpisode.media.latestEpisode || activeVideoEpisode.media.totalEpisodes || 24;
    if (activeVideoEpisode.episodeNumber >= maxEp) {
      setUpNextCountdown(null);
      return;
    }
    const nextEpNum = activeVideoEpisode.episodeNumber + 1;
    setUpNextCountdown(null);
    userPausedRef.current = false;
    pendingResumeTimeRef.current = null;
    savedTimestampRef.current = 0;
    hasAppliedInitialSeekRef.current = false;
    setCurrentTime(0);
    setLiveSubTime(0);
    setActiveVideoEpisode({ media: activeVideoEpisode.media, episodeNumber: nextEpNum });
    showToast(`Playing Episode ${nextEpNum}`);
  }, [activeVideoEpisode, liveEpisodes, setActiveVideoEpisode, showToast]);

  const orderedEpisodeNumbers = React.useMemo(() => {
    if (!activeVideoEpisode) return [];
    const mediaObj = activeVideoEpisode.media;
    const maxEp =
      liveEpisodes.length > 0
        ? Math.max(...liveEpisodes.map((e) => e.number))
        : mediaObj.latestEpisode || mediaObj.totalEpisodes || 24;

    if (liveEpisodes.length > 0) {
      return Array.from(new Set(liveEpisodes.map((e) => e.number))).sort((a, b) => a - b);
    }
    return Array.from({ length: maxEp }, (_, i) => i + 1);
  }, [activeVideoEpisode, liveEpisodes]);

  const currentEpIndex = activeVideoEpisode
    ? orderedEpisodeNumbers.indexOf(activeVideoEpisode.episodeNumber)
    : -1;

  const prevEpisodeNumber = activeVideoEpisode
    ? currentEpIndex > 0
      ? orderedEpisodeNumbers[currentEpIndex - 1]
      : currentEpIndex === -1 && activeVideoEpisode.episodeNumber > 1
      ? activeVideoEpisode.episodeNumber - 1
      : null
    : null;

  const nextEpisodeNumber = activeVideoEpisode
    ? currentEpIndex !== -1 && currentEpIndex < orderedEpisodeNumbers.length - 1
      ? orderedEpisodeNumbers[currentEpIndex + 1]
      : currentEpIndex === -1 &&
        activeVideoEpisode.episodeNumber < (orderedEpisodeNumbers[orderedEpisodeNumbers.length - 1] || 0)
      ? activeVideoEpisode.episodeNumber + 1
      : null
    : null;

  const jumpToEpisode = useCallback(
    (targetEpNum: number) => {
      if (!activeVideoEpisode || isLocked) return;
      setUpNextCountdown(null);
      userPausedRef.current = false;
      pendingResumeTimeRef.current = null;
      savedTimestampRef.current = 0;
      hasAppliedInitialSeekRef.current = false;
      setCurrentTime(0);
      setLiveSubTime(0);
      setActiveVideoEpisode({ media: activeVideoEpisode.media, episodeNumber: targetEpNum });
      showToast(`Playing Episode ${targetEpNum}`);
      resetControlsTimer();
    },
    [activeVideoEpisode, isLocked, setActiveVideoEpisode, showToast, resetControlsTimer]
  );

  const handlePreviousEpisode = useCallback(() => {
    if (isLocked || prevEpisodeNumber === null) return;
    jumpToEpisode(prevEpisodeNumber);
  }, [isLocked, prevEpisodeNumber, jumpToEpisode]);

  const handleNextEpisode = useCallback(() => {
    if (isLocked || nextEpisodeNumber === null) return;
    jumpToEpisode(nextEpisodeNumber);
  }, [isLocked, nextEpisodeNumber, jumpToEpisode]);

  useEffect(() => {
    if (upNextCountdown === null) return;
    if (upNextCountdown <= 0) {
      playNextEpisodeNow();
      return;
    }
    const timer = setTimeout(() => {
      setUpNextCountdown((prev) => (prev !== null ? prev - 1 : null));
    }, 1000);
    return () => clearTimeout(timer);
  }, [upNextCountdown, playNextEpisodeNow]);

  if (!activeVideoEpisode) return null;

  const { media, episodeNumber } = activeVideoEpisode;
  const maxLiveEpisode =
    liveEpisodes.length > 0
      ? Math.max(...liveEpisodes.map((e) => e.number))
      : media.latestEpisode || media.totalEpisodes || 24;
  const totalEpisodeCount = liveEpisodes.length > 0 ? liveEpisodes.length : maxLiveEpisode;

  // Filtered episodes for drawer (Exact number match when searching by number)
  const trimmedSearchQuery = episodeSearchQuery.trim();
  const parsedSearchNumber = (() => {
    if (!trimmedSearchQuery) return null;
    const match = trimmedSearchQuery.match(/^(?:ep(?:isode)?\s*|\#\s*)?(\d+)$/i);
    return match ? parseInt(match[1], 10) : null;
  })();

  const filteredEpisodes = (liveEpisodes.length > 0
    ? liveEpisodes
    : Array.from({ length: totalEpisodeCount }, (_, i) => ({
        id: `ep-${i + 1}`,
        number: i + 1,
        title: `Episode ${i + 1}`,
      }))
  ).filter((ep) => {
    if (!trimmedSearchQuery) return true;
    if (parsedSearchNumber !== null) {
      // Exactly match the episode number (e.g. searching 10 returns ONLY episode 10)
      return ep.number === parsedSearchNumber;
    }
    return Boolean(ep.title && ep.title.toLowerCase().includes(trimmedSearchQuery.toLowerCase()));
  });

  const currentSpeedNum = Math.min(
    3.0,
    Math.max(0.25, Math.round((parseFloat(playbackSpeed.replace('x', '')) || 1.0) * 20) / 20)
  );
  const formatSpeedValue = (val: number) => `${parseFloat(val.toFixed(2))}×`;
  const speedTickValues = Array.from({ length: 56 }, (_, i) => Number((0.25 + i * 0.05).toFixed(2)));
  const speedPresetValues = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

  // Available Subtitle Languages (matching screenshot: English, Indonesian, Thai, plus dynamic tracks)
  const subtitleLanguages = Array.from(
    new Set([
      'English',
      'Indonesian',
      'Thai',
      ...(streamData?.subtitles?.map((s) => s.label || s.lang).filter(Boolean) || []),
      'Spanish',
      'French',
      'German',
      'Portuguese',
      'Arabic',
    ])
  ).filter((l) => l.toLowerCase() !== 'off');

  const currentSources = currentManifest?.sources || streamData?.sources || [];
  const activeSource = currentSources[activeSourceIndex] || currentSources[0];

  // Live custom subtitle overlay calculation synced with SubDelay + Settings Appearance
  const activeSubDelayMs = activeDrawer === 'subdelay' ? tempSubDelayMs : subDelayMs;
  const effectiveSubTime = liveSubTime + activeSubDelayMs / 1000;
  const activeSubtitleCues =
    selectedSubtitle === 'Off' || parsedSubtitleCues.length === 0
      ? []
      : parsedSubtitleCues
          .filter((cue) => effectiveSubTime >= cue.startSeconds && effectiveSubTime < cue.endSeconds)
          .filter((cue, idx, arr) => arr.findIndex((c) => c.text === cue.text) === idx);

  const subFont = settings.subtitleFont || 'Netflix Sans';
  const subSize = settings.subtitleSize ?? 15;
  const subElevation = settings.subtitleElevation ?? -10;
  const subTextColor = settings.subtitleTextColor || 'White';
  const subEdgeStyle = settings.subtitleEdgeStyle || 'Drop Shadow';
  const subEdgeColor = settings.subtitleEdgeColor || 'Black';
  const subBackground = settings.subtitleBackground || 'Soft Scrim';
  const baseSubBottomPercent = Math.max(2, Math.min(75, 4 + (subElevation + 20) * 0.75));
  const subtitleBottomPercent =
    showControls && !isLocked && !activeDrawer
      ? Math.max(baseSubBottomPercent, 19)
      : baseSubBottomPercent;

  return (
    <div
      ref={containerRef}
      onPointerDown={handlePlayerPointerDown}
      onPointerMove={handlePlayerPointerMove}
      onPointerUp={handlePlayerPointerEnd}
      onPointerCancel={handlePlayerPointerEnd}
      onContextMenu={(e) => e.preventDefault()}
      onMouseMove={() => {
        if (!gestureRef.current && Date.now() - lastTouchTimeRef.current > 900) {
          resetControlsTimer();
        }
      }}
      onClick={() => {
        if (suppressNextClickRef.current) return;
        handleScreenTap();
      }}
      className={`fixed z-[5000] bg-black flex flex-col justify-between overflow-hidden select-none touch-none transition-all duration-300 ${
        landscapeFirst
          ? 'portrait:top-1/2 portrait:left-1/2 portrait:w-[100dvh] portrait:h-[100dvw] portrait:-translate-x-1/2 portrait:-translate-y-1/2 portrait:rotate-90 portrait:origin-center landscape:inset-0 landscape:w-full landscape:h-full landscape:transform-none'
          : 'inset-0 w-full h-full transform-none'
      }`}
    >
      {/* Ambient Glow Background Effect */}
      {ambientLightEnabled && (
        <div className="absolute inset-0 pointer-events-none opacity-40 blur-3xl scale-125 bg-gradient-to-tr from-purple-700/50 via-blue-700/40 to-cyan-500/50" />
      )}

      {/* 1. VIDEO SURFACE STAGE */}
      <div className="absolute inset-0 flex items-center justify-center bg-[#07070A]">
        {isLoadingStream ? (
          <div className="flex items-center justify-center z-10">
            <DotPulseLoader size="2xl" color="bg-[#9d62f8]" />
          </div>
        ) : streamError || currentSources.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-6 text-center max-w-md mx-auto space-y-4 z-10 bg-[#181a22]/90 border border-white/10 rounded-3xl shadow-2xl backdrop-blur-md">
            <div className="p-3 rounded-full bg-purple-500/10 text-purple-400 border border-purple-500/20">
              <Tv className="w-8 h-8" />
            </div>
            <div className="space-y-1">
              <h3 className="text-base font-bold text-white">
                {SERVER_METADATA[selectedServer]?.name || 'Anime'} Stream Unavailable
              </h3>
              <p className="text-xs text-white/60">
                {streamError || `No stream sources were returned by ${SERVER_METADATA[selectedServer]?.name || 'this source'} for this episode.`}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={() => {
                  setStreamError(null);
                  setIsLoadingStream(true);
                  setRetryCount((c) => c + 1);
                }}
                className="flex items-center gap-2 px-4 py-2 rounded-full bg-purple-600 hover:bg-purple-500 text-xs font-bold text-white transition-all cursor-pointer shadow-lg"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Retry</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="relative w-full h-full flex items-center justify-center">
            <video
              ref={videoRef}
              className={`w-full h-full bg-black transition-all duration-200 ${
                isVideoFrameZoomed ? 'object-cover' : 'object-contain'
              }`}
              style={{
                filter: brightness !== 1 ? `brightness(${brightness})` : undefined,
              }}
              playsInline
              preload="auto"
              onLoadedMetadata={() => {
                if (videoRef.current) {
                  const vidDur = videoRef.current.duration || 0;
                  setDuration(vidDur);
                  updateBufferedRange();
                  const targetTime =
                    pendingResumeTimeRef.current ?? savedTimestampRef.current ?? activeVideoEpisode?.initialTime ?? 0;
                  if (targetTime > 0 && !hasAppliedInitialSeekRef.current) {
                    try {
                      videoRef.current.currentTime = targetTime;
                      setCurrentTime(targetTime);
                      setLiveSubTime(targetTime);
                      hasAppliedInitialSeekRef.current = true;
                    } catch {}
                  }
                  if (activeVideoEpisode && vidDur > 0) {
                    recordAnimeWatchProgress(
                      activeVideoEpisode.media,
                      activeVideoEpisode.episodeNumber,
                      targetTime > 0 ? targetTime : videoRef.current.currentTime,
                      vidDur
                    );
                  }
                }
              }}
              onCanPlay={() => {
                setIsBuffering(false);
                updateBufferedRange();
                if (videoRef.current) {
                  if (userPausedRef.current && !videoRef.current.paused) {
                    videoRef.current.pause();
                    setIsPlaying(false);
                  }
                  const targetTime =
                    pendingResumeTimeRef.current ?? savedTimestampRef.current ?? activeVideoEpisode?.initialTime ?? 0;
                  if (
                    targetTime > 0 &&
                    (!hasAppliedInitialSeekRef.current ||
                      (pendingResumeTimeRef.current !== null &&
                        Math.abs(videoRef.current.currentTime - targetTime) > 2))
                  ) {
                    try {
                      videoRef.current.currentTime = targetTime;
                      setCurrentTime(targetTime);
                      hasAppliedInitialSeekRef.current = true;
                    } catch {}
                  }
                  if (
                    pendingResumeTimeRef.current !== null &&
                    Math.abs(videoRef.current.currentTime - pendingResumeTimeRef.current) <= 2
                  ) {
                    pendingResumeTimeRef.current = null;
                  }
                }
              }}
              onProgress={updateBufferedRange}
              onTimeUpdate={() => {
                if (videoRef.current) {
                  const t = videoRef.current.currentTime;
                  if (!isScrubbingRef.current) {
                    setCurrentTime(t);
                    setLiveSubTime(t);
                  }
                  if (
                    pendingResumeTimeRef.current !== null &&
                    Math.abs(t - pendingResumeTimeRef.current) <= 2
                  ) {
                    pendingResumeTimeRef.current = null;
                  }
                  setDuration(videoRef.current.duration || 0);
                  updateBufferedRange();
                  if (!videoRef.current.paused) {
                    setIsBuffering(false);
                  }

                  // Keep watch history & frame accurately in sync periodically (every 5 seconds)
                  if (activeVideoEpisode && Math.abs(t - lastRecordedTimeRef.current) >= 5) {
                    lastRecordedTimeRef.current = t;
                    recordAnimeWatchProgress(
                      activeVideoEpisode.media,
                      activeVideoEpisode.episodeNumber,
                      t,
                      videoRef.current.duration,
                      captureCurrentVideoFrame()
                    );
                  }

                  if (stallTimerRef.current) {
                    clearTimeout(stallTimerRef.current);
                    stallTimerRef.current = null;
                  }
                }
              }}
              onWaiting={() => {
                if (userPausedRef.current) return;
                setIsBuffering(true);
                if (!stallTimerRef.current) {
                  stallTimerRef.current = setTimeout(() => {
                    stallTimerRef.current = null;
                    const v = videoRef.current;
                    if (!v || userPausedRef.current || v.paused) return;
                    if (hlsRef.current) {
                      hlsRef.current.startLoad();
                    }
                    try {
                      if (v.buffered && v.buffered.length > 0) {
                        const t = v.currentTime;
                        for (let i = 0; i < v.buffered.length; i++) {
                          if (v.buffered.start(i) > t && v.buffered.start(i) - t <= 2.5) {
                            v.currentTime = v.buffered.start(i) + 0.05;
                            break;
                          }
                        }
                      }
                    } catch {}
                  }, 6000);
                }
              }}
              onStalled={() => {
                if (userPausedRef.current) return;
                setIsBuffering(true);
                if (hlsRef.current) {
                  hlsRef.current.startLoad();
                }
              }}
              onPlay={() => {
                if (userPausedRef.current && videoRef.current) {
                  videoRef.current.pause();
                  setIsPlaying(false);
                  return;
                }
                setIsPlaying(true);
              }}
              onPlaying={() => {
                if (userPausedRef.current && videoRef.current) {
                  videoRef.current.pause();
                  setIsPlaying(false);
                  setIsBuffering(false);
                  return;
                }
                setIsPlaying(true);
                setIsBuffering(false);
                if (stallTimerRef.current) {
                  clearTimeout(stallTimerRef.current);
                  stallTimerRef.current = null;
                }
              }}
              onPause={() => {
                setIsPlaying(false);
                setIsBuffering(false);
                setIsHoldSpeed2x(false);
                if (hold2xTimerRef.current) {
                  clearTimeout(hold2xTimerRef.current);
                  hold2xTimerRef.current = null;
                }
                if (gestureRef.current?.mode === 'speed2x') {
                  gestureRef.current.mode = 'cancelled';
                }
                if (stallTimerRef.current) {
                  clearTimeout(stallTimerRef.current);
                  stallTimerRef.current = null;
                }
                if (videoRef.current) {
                  videoRef.current.playbackRate = parseFloat(playbackSpeed.replace('x', '')) || 1.0;
                }
                if (videoRef.current && activeVideoEpisode) {
                  recordAnimeWatchProgress(
                    activeVideoEpisode.media,
                    activeVideoEpisode.episodeNumber,
                    videoRef.current.currentTime,
                    videoRef.current.duration,
                    captureCurrentVideoFrame()
                  );
                }
              }}
              onError={() => {
                console.warn('Video element onError triggered, auto-failing over...');
                triggerAutoFailoverRef.current('Video playback error');
              }}
              onEnded={() => {
                setIsHoldSpeed2x(false);
                if (hold2xTimerRef.current) {
                  clearTimeout(hold2xTimerRef.current);
                  hold2xTimerRef.current = null;
                }
                if (episodeNumber < maxLiveEpisode) {
                  setUpNextCountdown(6);
                }
              }}
            />

            {/* CUSTOM LIVE SUBTITLE OVERLAY (Synced with SubDelay + Settings Appearance) */}
            {selectedSubtitle !== 'Off' && activeSubtitleCues.length > 0 && (
              <div
                className="absolute inset-x-4 sm:inset-x-10 z-[12] flex flex-col items-center justify-end gap-1.5 text-center pointer-events-none select-none transition-[bottom] duration-200"
                style={{
                  bottom: `${subtitleBottomPercent}%`,
                }}
              >
                {activeSubtitleCues.map((cue) => (
                  <span
                    key={`${cue.id}-${subFont}`}
                    className="inline-block max-w-[92%] sm:max-w-[78%] px-2.5 py-1 rounded-md leading-snug whitespace-pre-line break-words transition-all duration-100"
                    style={{
                      fontFamily: getSubtitleFontFamily(subFont),
                      fontSize: `${subSize}px`,
                      color: getSubtitleTextColorHex(subTextColor),
                      backgroundColor: getSubtitleBackgroundHex(subBackground),
                      textShadow: getSubtitleEdgeTextShadow(subEdgeStyle, subEdgeColor),
                    }}
                  >
                    {cue.text}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 2. TOP OVERLAY HEADER */}
      <div
        onClick={(e) => {
          e.stopPropagation();
          resetControlsTimer();
        }}
        className={`relative z-20 flex items-center justify-between gap-3 p-4 sm:p-5 transition-opacity duration-300 ${
          showControls && !isLocked ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
      >
        {/* Back Action Button + Dynamic Metadata Label */}
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={() => {
              if (activeVideoEpisode) {
                const v = videoRef.current;
                const exactTime = v ? v.currentTime : savedTimestampRef.current;
                const exactDuration = v && v.duration ? v.duration : duration;
                const frame = captureCurrentVideoFrame();
                recordAnimeWatchProgress(
                  activeVideoEpisode.media,
                  activeVideoEpisode.episodeNumber,
                  exactTime,
                  exactDuration,
                  frame
                );
              }
              setActiveVideoEpisode(null);
            }}
            className="w-10 h-10 rounded-full bg-[#181a22]/90 hover:bg-white/20 border border-white/10 flex items-center justify-center text-white cursor-pointer shadow-lg transition-all active:scale-95 shrink-0"
            aria-label="Back"
          >
            <ChevronLeft className="w-5 h-5 stroke-[2.5]" />
          </button>

          <div className="flex flex-col min-w-0">
            <h1 className="text-base sm:text-lg font-bold text-white leading-tight tracking-tight drop-shadow-md truncate">
              Episode {episodeNumber}
            </h1>
            <p className="text-xs sm:text-sm text-white/70 font-normal truncate leading-tight mt-0.5 drop-shadow-sm max-w-[260px] sm:max-w-xl">
              {media.title}
            </p>
          </div>
        </div>

        {/* Right Upper Corner: Settings Gear Circular Button */}
        <button
          type="button"
          onClick={() => setActiveDrawer(activeDrawer === 'settings' ? null : 'settings')}
          className={`w-10 h-10 sm:w-11 sm:h-11 rounded-full bg-[#18181c]/90 hover:bg-[#24242a] flex items-center justify-center shadow-lg backdrop-blur-md transition-all cursor-pointer select-none active:scale-95 focus:outline-none shrink-0 ${
            activeDrawer === 'settings' ? 'text-[#b876fc]' : 'text-white'
          }`}
          title="Player Settings"
          aria-label="Player Settings"
        >
          <Settings className="w-5 h-5 stroke-[2.2]" />
        </button>
      </div>

      {/* DOUBLE-TAP SEEK RIPPLE & VISUAL ANIMATION (-10s Left / +10s Right) */}
      {doubleTapIndicator && (
        <div
          key={doubleTapIndicator.key}
          className={`absolute inset-y-0 z-[15] w-[44%] flex items-center justify-center pointer-events-none animate-in fade-in zoom-in-95 duration-150 ${
            doubleTapIndicator.side === 'left'
              ? 'left-0 rounded-r-[999px] bg-gradient-to-r from-white/15 via-white/10 to-transparent'
              : 'right-0 rounded-l-[999px] bg-gradient-to-l from-white/15 via-white/10 to-transparent'
          }`}
        >
          <div className="flex flex-col items-center justify-center gap-1.5 px-5 py-3 rounded-2xl bg-black/55 backdrop-blur-md border border-white/15 shadow-2xl">
            <div className="flex items-center gap-1 text-[#b876fc]">
              {doubleTapIndicator.side === 'left' ? (
                <ChevronsLeft className="w-8 h-8 stroke-[2.6] animate-pulse" />
              ) : (
                <ChevronsRight className="w-8 h-8 stroke-[2.6] animate-pulse" />
              )}
            </div>
            <span className="text-xs sm:text-sm font-extrabold text-white tracking-wide font-mono">
              {doubleTapIndicator.side === 'left'
                ? `-${doubleTapIndicator.seconds}s`
                : `+${doubleTapIndicator.seconds}s`}
            </span>
          </div>
        </div>
      )}

      {/* SWIPE BRIGHTNESS (LEFT) & VOLUME (RIGHT) VISUAL HUD (Exact same top-center position & pill style as 2x HUD) */}
      {swipeHud && (
        <div className="absolute top-5 sm:top-7 left-1/2 -translate-x-1/2 z-30 pointer-events-none select-none animate-in fade-in zoom-in-95 duration-150">
          <div className="flex items-center gap-2 px-4 py-1.5 sm:py-2 rounded-full bg-[#161619]/85 backdrop-blur-md shadow-[0_6px_24px_rgba(0,0,0,0.65)]">
            {swipeHud.type === 'brightness' ? (
              <Sun className="w-[18px] h-[18px] sm:w-5 sm:h-5 text-white stroke-[2.2]" />
            ) : swipeHud.percent === 0 ? (
              <VolumeX className="w-[18px] h-[18px] sm:w-5 sm:h-5 text-white stroke-[2.2]" />
            ) : (
              <Volume2 className="w-[18px] h-[18px] sm:w-5 sm:h-5 text-white stroke-[2.2]" />
            )}
            <span className="text-[13px] sm:text-sm font-bold text-white tracking-tight leading-none">
              {swipeHud.percent}%
            </span>
          </div>
        </div>
      )}

      {/* HOLD-FOR-2X SPEED ANIMATED VISUAL HUD */}
      {isHoldSpeed2x && (
        <div className="absolute top-5 sm:top-7 left-1/2 -translate-x-1/2 z-30 pointer-events-none select-none animate-in fade-in zoom-in-95 duration-150">
          <div className="flex items-center gap-2 px-4 py-1.5 sm:py-2 rounded-full bg-[#161619]/85 backdrop-blur-md shadow-[0_6px_24px_rgba(0,0,0,0.65)]">
            <FastForward className="w-[18px] h-[18px] sm:w-5 sm:h-5 text-white fill-none stroke-[2.2] animate-pulse" />
            <span className="text-[13px] sm:text-sm font-bold text-white tracking-tight leading-none">
              2x
            </span>
          </div>
        </div>
      )}

      {/* NON-BLOCKING BUFFERING INDICATOR */}
      {isBuffering && !isLoadingStream && !streamError && !userPausedRef.current && (
        <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
          <div className="p-3 rounded-full bg-black/45 backdrop-blur-sm">
            <DotPulseLoader size="lg" color="bg-[#b876fc]" />
          </div>
        </div>
      )}

      {/* 3. CENTER PLAYBACK CONTROLS (Previous Episode, Play/Pause, Next Episode) */}
      <div
        onClick={(e) => {
          e.stopPropagation();
          resetControlsTimer();
        }}
        className={`absolute inset-0 z-20 flex items-center justify-center pointer-events-none transition-opacity duration-300 ${
          showControls && !isLocked ? 'opacity-100' : 'opacity-0'
        }`}
      >
        <div
          className={`flex items-center gap-5 sm:gap-7 select-none ${
            showControls && !isLocked ? 'pointer-events-auto' : 'pointer-events-none'
          }`}
        >
          {/* Previous Episode Button */}
          <button
            type="button"
            disabled={prevEpisodeNumber === null}
            onClick={(e) => {
              e.stopPropagation();
              handlePreviousEpisode();
            }}
            className={`w-12 h-12 sm:w-14 sm:h-14 rounded-full bg-black/80 flex items-center justify-center transition-all ${
              prevEpisodeNumber === null
                ? 'text-white/35 cursor-not-allowed'
                : 'text-white hover:bg-black/90 hover:scale-105 active:scale-95 cursor-pointer'
            }`}
            title={prevEpisodeNumber !== null ? `Previous Episode (${prevEpisodeNumber})` : 'No previous episode'}
            aria-label="Previous Episode"
          >
            <SkipBack className="w-6 h-6 sm:w-7 sm:h-7 fill-none stroke-[2.2]" />
          </button>

          {/* Dynamic Play / Pause Button */}
          <button
            type="button"
            onClick={togglePlay}
            className="w-[68px] h-[68px] sm:w-[76px] sm:h-[76px] rounded-full bg-black/80 hover:bg-black/90 flex items-center justify-center text-white hover:scale-105 active:scale-95 transition-all cursor-pointer"
            aria-label={isPlaying ? 'Pause' : 'Play'}
          >
            {isPlaying ? (
              <Pause className="w-7 h-7 sm:w-8 sm:h-8 fill-none stroke-[2.2]" />
            ) : (
              <Play className="w-7 h-7 sm:w-8 sm:h-8 fill-none stroke-[2.2] ml-0.5" />
            )}
          </button>

          {/* Next Episode Button */}
          <button
            type="button"
            disabled={nextEpisodeNumber === null}
            onClick={(e) => {
              e.stopPropagation();
              handleNextEpisode();
            }}
            className={`w-12 h-12 sm:w-14 sm:h-14 rounded-full bg-black/80 flex items-center justify-center transition-all ${
              nextEpisodeNumber === null
                ? 'text-white/35 cursor-not-allowed'
                : 'text-white hover:bg-black/90 hover:scale-105 active:scale-95 cursor-pointer'
            }`}
            title={nextEpisodeNumber !== null ? `Next Episode (${nextEpisodeNumber})` : 'No next episode'}
            aria-label="Next Episode"
          >
            <SkipForward className="w-6 h-6 sm:w-7 sm:h-7 fill-none stroke-[2.2]" />
          </button>
        </div>
      </div>

      {/* 4. TIMELINE & BOTTOM NAVIGATION TOOLBAR */}
      <div
        onClick={(e) => {
          e.stopPropagation();
          if (!isLocked) resetControlsTimer();
        }}
        className={`relative z-20 p-4 sm:p-6 space-y-3 ${
          showControls && !isLocked ? 'pointer-events-auto' : 'pointer-events-none'
        }`}
      >
        {/* A. FLOATING BADGES (Above Timeline) */}
        <div className="flex items-center justify-between px-1">
          {/* Left Badges: Fixed-spot Lock/Unlock Screen & Audio SUB/DUB Pill */}
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                toggleLock();
              }}
              className={`p-1.5 rounded-xl text-white transition-opacity duration-300 cursor-pointer active:scale-95 ${
                (isLocked ? showUnlockPrompt : showControls)
                  ? 'opacity-100 pointer-events-auto hover:text-white/80'
                  : 'opacity-0 pointer-events-none'
              }`}
              title={isLocked ? 'Unlock Screen' : 'Lock Screen'}
              aria-label={isLocked ? 'Unlock Screen' : 'Lock Screen'}
            >
              {isLocked ? (
                <Lock className="w-5 h-5 stroke-[2.2]" />
              ) : (
                <Unlock className="w-5 h-5 stroke-[2.2]" />
              )}
            </button>

            <button
              onClick={() => handleSwitchAudioTrack(audioTrack === 'sub' ? 'dub' : 'sub')}
              className={`px-2.5 py-0.5 rounded-full bg-[#8b5cf6] hover:bg-[#7c3aed] text-white text-[11px] font-bold uppercase tracking-wider shadow-[0_0_12px_rgba(139,92,246,0.5)] border border-purple-400/40 transition-all duration-300 cursor-pointer active:scale-95 ${
                showControls && !isLocked ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
              }`}
              title="Toggle Audio Sub / Dub"
            >
              {audioTrack}
            </button>
          </div>
        </div>

        {/* B. TIMELINE PROGRESS SCRUBBER */}
        <div
          className={`flex items-center gap-3 px-1 transition-opacity duration-300 ${
            showControls && !isLocked ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
          }`}
        >
          <span className="text-xs font-bold text-white/90 font-mono tracking-tight shrink-0">
            {formatTime(currentTime)}
          </span>

          <div className="relative flex-1 flex items-center h-6 select-none group touch-none cursor-pointer">
            {/* 1. Background Unwatched Track with Real Buffer Range */}
            <div className="relative inset-x-0 w-full h-[3.5px] sm:h-1 bg-white/20 rounded-full overflow-hidden">
              {/* Pre-buffered Video Track */}
              <div
                className="absolute inset-y-0 left-0 bg-white/35 rounded-full transition-[width] duration-150"
                style={{
                  width: `${duration > 0 ? Math.min(100, Math.max(0, (bufferedTime / duration) * 100)) : 0}%`,
                }}
              />
              {/* 2. Watched Purple Track */}
              <div
                className="relative h-full bg-[#b876fc] rounded-full transition-[width] duration-75"
                style={{
                  width: `${duration > 0 ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) : 0}%`,
                }}
              />
            </div>

            {/* 3. Full-width Range Slider for Touch & Drag Seeking */}
            <input
              type="range"
              min={0}
              max={duration || 100}
              value={currentTime}
              onPointerDown={() => {
                isScrubbingRef.current = true;
                if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
                setShowControls(true);
              }}
              onInput={(e: any) => {
                const val = Number(e.target.value);
                setCurrentTime(val);
                setLiveSubTime(val);
                if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
                setShowControls(true);
              }}
              onChange={(e) => {
                const val = Number(e.target.value);
                handleSeek(val);
                isScrubbingRef.current = false;
                resetControlsTimer();
              }}
              onPointerUp={(e: any) => {
                const val = Number(e.currentTarget.value);
                handleSeek(val);
                isScrubbingRef.current = false;
                resetControlsTimer();
              }}
              onPointerCancel={() => {
                isScrubbingRef.current = false;
                resetControlsTimer();
              }}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer focus:outline-none z-10 touch-none"
            />
          </div>

          <span className="text-xs font-bold text-white/90 font-mono tracking-tight shrink-0">
            {formatTime(duration || 0)}
          </span>
        </div>

        {/* C. BOTTOM NAVIGATION TOOLBAR (Left & Right Capsules matching exact screenshot) */}
        <div
          className={`flex items-center justify-between pt-1 px-1 transition-opacity duration-300 ${
            showControls && !isLocked ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
          }`}
        >
          {/* Left Controls Group: Separate Subtitle & Episode List circular buttons */}
          <div className="flex items-center gap-2.5 sm:gap-3">
            <button
              type="button"
              onClick={() => setActiveDrawer(activeDrawer === 'subtitles' ? null : 'subtitles')}
              className={`w-10 h-10 sm:w-11 sm:h-11 rounded-full bg-[#18181c]/90 hover:bg-[#24242a] flex items-center justify-center shadow-lg backdrop-blur-md transition-all cursor-pointer select-none active:scale-95 focus:outline-none ${
                activeDrawer === 'subtitles' ? 'text-[#b876fc]' : 'text-white'
              }`}
              title="Subtitles & Audio"
              aria-label="Subtitles & Audio"
            >
              <Captions className="w-5 h-5 stroke-[2.2]" />
            </button>

            <button
              type="button"
              onClick={() => setActiveDrawer(activeDrawer === 'episodes' ? null : 'episodes')}
              className={`w-10 h-10 sm:w-11 sm:h-11 rounded-full bg-[#18181c]/90 hover:bg-[#24242a] flex items-center justify-center shadow-lg backdrop-blur-md transition-all cursor-pointer select-none active:scale-95 focus:outline-none ${
                activeDrawer === 'episodes' ? 'text-[#b876fc]' : 'text-white'
              }`}
              title="Episode List"
              aria-label="Episode List"
            >
              <ListVideo className="w-5 h-5 stroke-[2.2]" />
            </button>
          </div>

          {/* Right Controls Group: Quality Selector ("HD") + Speedometer + Fullscreen */}
          <div className="flex items-center gap-1.5 p-1 bg-[#181a22]/90 border border-white/10 rounded-2xl shadow-xl backdrop-blur-md">
            {/* Quality Selector Button ("HD" Icon) */}
            <button
              onClick={() => setActiveDrawer(activeDrawer === 'quality' ? null : 'quality')}
              className="p-2 sm:p-2.5 rounded-xl text-white/90 cursor-pointer font-bold text-xs flex items-center justify-center select-none focus:outline-none"
              title="Stream Quality & Server Selector"
              aria-label="Stream Quality & Server Selector"
            >
              <span className="border border-current px-1 py-0.5 rounded leading-none text-[10px] tracking-wider font-mono font-black">
                HD
              </span>
            </button>

            {/* Playback Speed Button (Speedometer Icon) */}
            <button
              onClick={() => setActiveDrawer(activeDrawer === 'speed' ? null : 'speed')}
              className="p-2 sm:p-2.5 rounded-xl text-white/90 cursor-pointer select-none focus:outline-none"
              title="Playback Speed"
              aria-label="Playback Speed"
            >
              <Gauge className="w-5 h-5" />
            </button>

            {/* Video Frame Full Screen Fit Toggle Button (Expands only video frame, NOT app) */}
            <button
              type="button"
              onClick={toggleVideoFrameZoom}
              className={`p-2 sm:p-2.5 rounded-xl cursor-pointer select-none focus:outline-none transition-colors ${
                isVideoFrameZoomed ? 'text-[#b876fc]' : 'text-white/90'
              }`}
              title={isVideoFrameZoomed ? 'Normal Video Frame' : 'Full Screen Video Frame'}
              aria-label={isVideoFrameZoomed ? 'Normal Video Frame' : 'Full Screen Video Frame'}
            >
              {isVideoFrameZoomed ? <Minimize2 className="w-5 h-5" /> : <Maximize2 className="w-5 h-5" />}
            </button>
          </div>
        </div>
      </div>

      {/* SKIP OPENING / SKIP ENDING FLOATING CARD (Always visible during Opening/Ending, exact design match) */}
      {shouldShowSkipButton && upNextCountdown === null && !isLocked && !activeDrawer && (
        <button
          type="button"
          data-no-gesture="true"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            handleDynamicSkip();
          }}
          className="absolute bottom-[110px] sm:bottom-[124px] right-4 sm:right-6 z-30 flex items-center gap-2.5 px-5 py-2.5 rounded-[16px] bg-black/80 hover:bg-black/90 border border-white/25 text-white shadow-[0_8px_28px_rgba(0,0,0,0.75)] backdrop-blur-md transition-all cursor-pointer active:scale-95 animate-in fade-in select-none"
          title={dynamicSkipLabel}
          aria-label={dynamicSkipLabel}
        >
          <span className="text-[14px] sm:text-[15px] font-bold tracking-tight leading-none">
            {dynamicSkipLabel}
          </span>
          <SkipForward className="w-4 h-4 sm:w-[18px] sm:h-[18px] stroke-[2.2]" />
        </button>
      )}

      {/* UP NEXT OVERLAY CARD (Exact Skip Ending corner position, 6s auto-play & clickable) */}
      {upNextCountdown !== null && episodeNumber < maxLiveEpisode && !isLocked && (
        <button
          type="button"
          data-no-gesture="true"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            playNextEpisodeNow();
          }}
          className="absolute bottom-[110px] sm:bottom-[124px] right-4 sm:right-6 z-30 flex flex-col items-start text-left px-5 py-2.5 rounded-[18px] bg-[#16151c]/95 hover:bg-[#1f1e29] border border-white/10 shadow-[0_10px_30px_rgba(0,0,0,0.85)] backdrop-blur-md transition-all cursor-pointer active:scale-95 animate-in fade-in select-none"
          aria-label={`Next Episode ${episodeNumber + 1}, Playing in ${upNextCountdown}s`}
        >
          <span className="text-[14px] sm:text-[15px] font-bold text-white leading-snug tracking-tight">
            Next Episode {episodeNumber + 1}
          </span>
          <span className="text-[12px] sm:text-[13px] font-semibold text-[#9d62f8] leading-snug mt-0.5">
            Playing in {upNextCountdown}s
          </span>
        </button>
      )}

      {/* 5. MODAL BOTTOM DRAWERS / SHEETS */}

      {/* DRAWER 1: SUBTITLES & AUDIO */}
      {activeDrawer === 'subtitles' && (
        <div
          onClick={() => setActiveDrawer(null)}
          className="absolute inset-0 z-50 flex items-end justify-center p-3 sm:p-5 pb-3 sm:pb-5 bg-black/40 animate-in fade-in select-none"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-[94%] max-w-[850px] bg-[#000000] border border-white/10 rounded-[24px] px-6 sm:px-8 pt-4 pb-6 max-h-[85%] text-white shadow-[0_20px_60px_rgba(0,0,0,0.85)] animate-in zoom-in-95 duration-150 flex flex-col"
          >
            {/* Pull Bar Handle */}
            <div className="w-12 h-1 bg-white/20 rounded-full mx-auto mb-3.5 shrink-0" />

            {/* Header: Title on Left, SubDelay & Apply Buttons on Right */}
            <div className="flex items-center justify-between gap-4 mb-3.5 shrink-0">
              <h3 className="text-lg sm:text-xl font-bold text-white tracking-tight">
                Subtitles & Audio
              </h3>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    setTempSubDelayMs(subDelayMs);
                    setActiveDrawer('subdelay');
                  }}
                  className="h-9 px-4 rounded-[12px] text-xs sm:text-[13px] font-semibold text-white bg-[#23262d] hover:bg-[#2c3039] transition-all cursor-pointer active:scale-95 flex items-center justify-center"
                >
                  SubDelay{subDelayMs !== 0 ? ` (${subDelayMs > 0 ? '+' : ''}${subDelayMs}ms)` : ''}
                </button>

                <button
                  onClick={() => {
                    setActiveDrawer(null);
                    showToast(`Applied: ${selectedSubtitle} Sub / ${audioTrack === 'sub' ? 'Japanese' : 'English'} Audio`);
                  }}
                  className="h-9 px-5 rounded-[12px] bg-[#a755f7] hover:bg-[#b86df9] text-white text-xs sm:text-[13px] font-bold transition-all cursor-pointer active:scale-95 flex items-center justify-center shadow-[0_2px_12px_rgba(167,85,247,0.35)]"
                >
                  Apply
                </button>
              </div>
            </div>

            {/* 2-Column Side-by-Side Content with Ultra-Thin Divider and Individual Scrollbars */}
            <div className="grid grid-cols-2 gap-4 sm:gap-6 pt-1">
              {/* LEFT COLUMN: SUBTITLES (Independent scroll container) */}
              <div className="flex flex-col min-w-0 pr-3 sm:pr-4 border-r border-white/10">
                <span className="block text-[11px] font-bold text-white/50 tracking-wider uppercase mb-2 shrink-0">
                  SUBTITLES
                </span>

                <div className="space-y-2 overflow-y-auto max-h-52 sm:max-h-60 pr-1.5 overscroll-contain scrollbar-thin scrollbar-thumb-white/20">
                  {/* Subtitle Off */}
                  <div
                    onClick={() => setSelectedSubtitle('Off')}
                    className={`h-11 sm:h-12 px-4 rounded-xl border flex items-center justify-between transition-all cursor-pointer active:scale-98 select-none ${
                      selectedSubtitle === 'Off'
                        ? 'border-[#a855f7] bg-[#241335]/70 text-white'
                        : 'border-white/10 bg-[#0c0d12] text-white/80 hover:bg-white/5'
                    }`}
                  >
                    <span className="text-xs sm:text-sm font-semibold">Off</span>
                    {selectedSubtitle === 'Off' && <Check className="w-4 h-4 text-[#a855f7]" />}
                  </div>

                  {/* Subtitle Languages */}
                  {subtitleLanguages.map((lang) => {
                    const isSelected = selectedSubtitle.toLowerCase() === lang.toLowerCase();
                    return (
                      <div
                        key={lang}
                        onClick={() => setSelectedSubtitle(lang)}
                        className={`h-11 sm:h-12 px-4 rounded-xl border flex items-center justify-between transition-all cursor-pointer active:scale-98 select-none ${
                          isSelected
                            ? 'border-[#a855f7] bg-[#241335]/70 text-white'
                            : 'border-white/10 bg-[#0c0d12] text-white/80 hover:bg-white/5'
                        }`}
                      >
                        <span className="text-xs sm:text-sm font-semibold truncate pr-2">{lang}</span>
                        {isSelected && <Check className="w-4 h-4 text-[#a855f7]" />}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* RIGHT COLUMN: AUDIO (Independent scroll container) */}
              <div className="flex flex-col min-w-0 pl-1 sm:pl-2">
                <span className="block text-[11px] font-bold text-white/50 tracking-wider uppercase mb-2 shrink-0">
                  AUDIO
                </span>

                <div className="space-y-2 overflow-y-auto max-h-52 sm:max-h-60 pr-1.5 overscroll-contain scrollbar-thin scrollbar-thumb-white/20">
                  {/* Japanese (Sub) */}
                  <div
                    onClick={() => handleSwitchAudioTrack('sub')}
                    className={`h-11 sm:h-12 px-4 rounded-xl border flex items-center justify-between transition-all cursor-pointer active:scale-98 select-none ${
                      audioTrack === 'sub'
                        ? 'border-[#a855f7] bg-[#241335]/70 text-white'
                        : 'border-white/10 bg-[#0c0d12] text-white/80 hover:bg-white/5'
                    }`}
                  >
                    <span className="text-xs sm:text-sm font-semibold truncate pr-2">Japanese</span>
                    {audioTrack === 'sub' && <Check className="w-4 h-4 text-[#a855f7]" />}
                  </div>

                  {/* English (Dub) */}
                  <div
                    onClick={() => handleSwitchAudioTrack('dub')}
                    className={`h-11 sm:h-12 px-4 rounded-xl border flex items-center justify-between transition-all cursor-pointer active:scale-98 select-none ${
                      audioTrack === 'dub'
                        ? 'border-[#a855f7] bg-[#241335]/70 text-white'
                        : 'border-white/10 bg-[#0c0d12] text-white/80 hover:bg-white/5'
                    }`}
                  >
                    <span className="text-xs sm:text-sm font-semibold truncate pr-2">English</span>
                    {audioTrack === 'dub' && <Check className="w-4 h-4 text-[#a855f7]" />}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* DRAWER: SUBDELAY MODAL CARD (Compact card matching user screenshot, NOT full screen) */}
      {activeDrawer === 'subdelay' && (
        <div
          onClick={() => setActiveDrawer(null)}
          className="absolute inset-0 z-50 flex items-end justify-center p-3 sm:p-5 pb-3 sm:pb-5 bg-black/40 animate-in fade-in select-none"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-[94%] max-w-[850px] h-[280px] sm:h-[300px] bg-[#0e1017] border border-white/10 rounded-[24px] px-5 sm:px-6 py-4 text-white shadow-[0_20px_60px_rgba(0,0,0,0.85)] animate-in zoom-in-95 duration-150 flex flex-col"
          >
            {/* Header: Title "SubDelay" on Left, Cancel & Apply Buttons on Right */}
            <div className="flex items-center justify-between gap-4 mb-3 shrink-0">
              <h3 className="text-lg sm:text-xl font-bold text-white tracking-tight">
                SubDelay
              </h3>

              <div className="flex items-center gap-2 sm:gap-2.5">
                <button
                  onClick={() => {
                    setTempSubDelayMs(subDelayMs);
                    setActiveDrawer('subtitles');
                  }}
                  className="h-8 sm:h-9 px-4 rounded-[12px] bg-[#23262d] hover:bg-[#2e323b] text-white text-xs sm:text-[13px] font-semibold transition-all cursor-pointer active:scale-95"
                >
                  Cancel
                </button>

                <button
                  onClick={() => {
                    setSubDelayMs(tempSubDelayMs);
                    setActiveDrawer(null);
                    showToast(
                      `Sub delay applied: ${
                        tempSubDelayMs === 0
                          ? '0 ms'
                          : `${tempSubDelayMs > 0 ? '+' : ''}${tempSubDelayMs} ms`
                      }`
                    );
                  }}
                  className="h-8 sm:h-9 px-4 sm:px-5 rounded-[12px] bg-[#a755f7] hover:bg-[#b86df9] text-white text-xs sm:text-[13px] font-bold transition-all cursor-pointer active:scale-95 shadow-[0_2px_12px_rgba(167,85,247,0.35)]"
                >
                  Apply
                </button>
              </div>
            </div>

            {/* 2-Column Content: Left = Subtitles & Timestamps, Right = Fine Offset Adjuster */}
            <div className="grid grid-cols-2 gap-3 sm:gap-6 min-h-0 flex-1 overflow-hidden">
              {/* LEFT COLUMN: SUBTITLES & TIMESTAMPS */}
              <div className="flex flex-col min-w-0 pr-3 sm:pr-5 border-r border-white/10">
                <span className="block text-xs font-semibold text-white/50 tracking-wider mb-2 shrink-0">
                  Subtitles
                </span>

                <div className="space-y-2.5 overflow-y-auto max-h-[180px] sm:max-h-[200px] pr-2 scrollbar-thin scrollbar-thumb-white/20 overscroll-contain">
                  {isLoadingSubCues ? (
                    <div className="flex items-center justify-center gap-2 py-8 text-white/50 text-xs">
                      <DotPulseLoader size="sm" />
                      <span>Loading subtitle cues...</span>
                    </div>
                  ) : parsedSubtitleCues.length === 0 ? (
                    <div className="py-8 text-center text-xs text-white/50">
                      No subtitles found for this track.
                    </div>
                  ) : (
                    parsedSubtitleCues.map((cue) => {
                      const effectiveTime = liveSubTime + (tempSubDelayMs / 1000);
                      const isCurrentCue =
                        effectiveTime >= cue.startSeconds &&
                        effectiveTime < cue.endSeconds;

                      return (
                        <div
                          key={cue.id}
                          onClick={() => {
                            if (videoRef.current) {
                              videoRef.current.currentTime = cue.startSeconds;
                              setCurrentTime(cue.startSeconds);
                              setLiveSubTime(cue.startSeconds);
                            }
                          }}
                          className={`group transition-all cursor-pointer select-none rounded-lg p-1.5 -mx-1.5 hover:bg-white/5 ${
                            isCurrentCue
                              ? 'bg-purple-950/40 text-purple-200'
                              : 'text-white'
                          }`}
                        >
                          <span
                            className={`text-[11px] font-mono font-medium block mb-0.5 ${
                              isCurrentCue ? 'text-purple-300' : 'text-white/50'
                            }`}
                          >
                            {cue.formattedTime}
                          </span>
                          <p
                            className={`text-xs sm:text-[13px] font-medium leading-relaxed group-hover:text-white ${
                              isCurrentCue ? 'text-white font-semibold' : 'text-white/90'
                            }`}
                          >
                            {cue.text}
                          </p>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              {/* RIGHT COLUMN: FINE OFFSET ADJUSTER CONTROLS */}
              <div className="flex flex-col items-center justify-center min-w-0 pl-3 sm:pl-5">
                <div className="flex items-center justify-center gap-2 sm:gap-3.5">
                  {/* < Button (-250ms) */}
                  <button
                    onClick={() => setTempSubDelayMs((prev) => prev - 250)}
                    className="w-9 h-9 sm:w-10 sm:h-10 rounded-[12px] bg-[#1a1c24] hover:bg-[#252834] border border-white/10 text-white flex items-center justify-center transition-all cursor-pointer active:scale-90"
                    title="-250ms"
                    aria-label="Decrease delay by 250ms"
                  >
                    <ChevronLeft className="w-4 h-4 sm:w-5 sm:h-5 stroke-[2.4]" />
                  </button>

                  {/* — (Minus) Button (-50ms) */}
                  <button
                    onClick={() => setTempSubDelayMs((prev) => prev - 50)}
                    className="w-9 h-9 sm:w-10 sm:h-10 rounded-[12px] bg-[#1a1c24] hover:bg-[#252834] border border-white/10 text-white flex items-center justify-center transition-all cursor-pointer active:scale-90"
                    title="-50ms"
                    aria-label="Decrease delay by 50ms"
                  >
                    <Minus className="w-4 h-4 sm:w-5 sm:h-5 stroke-[2.4]" />
                  </button>

                  {/* Offset Display Value */}
                  <span className="min-w-[75px] sm:min-w-[95px] text-center font-mono text-sm sm:text-base font-bold text-white tracking-wider select-none">
                    {tempSubDelayMs === 0
                      ? '0 ms'
                      : `${tempSubDelayMs > 0 ? '+' : ''}${tempSubDelayMs} ms`}
                  </span>

                  {/* + (Plus) Button (+50ms) */}
                  <button
                    onClick={() => setTempSubDelayMs((prev) => prev + 50)}
                    className="w-9 h-9 sm:w-10 sm:h-10 rounded-[12px] bg-[#1a1c24] hover:bg-[#252834] border border-white/10 text-white flex items-center justify-center transition-all cursor-pointer active:scale-90"
                    title="+50ms"
                    aria-label="Increase delay by 50ms"
                  >
                    <Plus className="w-4 h-4 sm:w-5 sm:h-5 stroke-[2.4]" />
                  </button>

                  {/* > Button (+250ms) */}
                  <button
                    onClick={() => setTempSubDelayMs((prev) => prev + 250)}
                    className="w-9 h-9 sm:w-10 sm:h-10 rounded-[12px] bg-[#1a1c24] hover:bg-[#252834] border border-white/10 text-white flex items-center justify-center transition-all cursor-pointer active:scale-90"
                    title="+250ms"
                    aria-label="Increase delay by 250ms"
                  >
                    <ChevronRight className="w-4 h-4 sm:w-5 sm:h-5 stroke-[2.4]" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* DRAWER 2: EPISODE LIST DRAWER */}
      {activeDrawer === 'episodes' && (
        <div
          onClick={() => setActiveDrawer(null)}
          className="absolute inset-0 z-50 flex items-end justify-center p-3 sm:p-5 pb-3 sm:pb-5 bg-black/40 animate-in fade-in select-none"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-[94%] max-w-[850px] bg-[#000000] border border-white/10 rounded-[24px] px-5 sm:px-8 pt-3 pb-6 max-h-[85%] text-white shadow-[0_20px_60px_rgba(0,0,0,0.85)] animate-in zoom-in-95 duration-150 flex flex-col"
          >
            {/* Pull Bar Handle */}
            <div className="w-12 h-1 bg-white/20 rounded-full mx-auto mb-3.5 shrink-0" />

            {/* Header: "Episodes" on Left, Search Bar Capsule on Right */}
            <div className="flex items-center justify-between gap-4 mb-4 shrink-0">
              <h3 className="text-lg sm:text-xl font-bold text-white tracking-tight">
                Episodes
              </h3>

              {/* Capsule Search Input */}
              <div className="relative flex items-center">
                <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-white/40 pointer-events-none" />
                <input
                  type="text"
                  value={episodeSearchQuery}
                  onChange={(e) => setEpisodeSearchQuery(e.target.value)}
                  placeholder="Search episodes"
                  className="w-[196px] sm:w-[260px] h-[40px] bg-[#14161f] border border-white/10 rounded-2xl pl-10 pr-4 text-xs sm:text-sm text-white placeholder:text-white/40 outline-none focus:outline-none focus:ring-0 focus:border-white/10 transition-colors"
                />
              </div>
            </div>

            {/* Episode Number Pills Grid (Row of 12 in landscape) */}
            {filteredEpisodes.length === 0 ? (
              <div className="py-12 text-center text-xs text-white/50">
                Episode not found
              </div>
            ) : (
              <div className="grid grid-cols-6 sm:grid-cols-8 md:grid-cols-12 gap-2 sm:gap-2.5 overflow-y-auto max-h-56 sm:max-h-64 pt-1 pr-1 pb-2">
                {filteredEpisodes.map((ep) => {
                  const isCurrent = episodeNumber === ep.number;
                  return (
                    <button
                      key={ep.id || ep.number}
                      onClick={() => {
                        setActiveVideoEpisode({ media, episodeNumber: ep.number });
                        setActiveDrawer(null);
                        showToast(`Playing Episode ${ep.number}`);
                      }}
                      className={`h-10 sm:h-11 w-[calc(100%-5px)] mx-auto rounded-[14px] text-xs sm:text-sm font-bold transition-all cursor-pointer flex items-center justify-center select-none active:scale-95 overflow-hidden ${
                        isCurrent
                          ? 'bg-[#241335] border border-[#a855f7] ring-1 ring-[#a855f7]/60 text-[#d8b4fe] font-black'
                          : 'bg-[#0a0a0c] border border-white/10 text-white hover:bg-white/10'
                      }`}
                    >
                      <span>{ep.number}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* DRAWER 3: PLAYER QUALITY & SERVER SELECTOR DRAWER */}
      {activeDrawer === 'quality' && (
        <div
          onClick={() => setActiveDrawer(null)}
          className="absolute inset-0 z-50 flex items-end justify-center p-3 sm:p-5 pb-3 sm:pb-5 bg-black/40 animate-in fade-in select-none"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-[94%] max-w-[850px] bg-[#000000] border border-white/10 rounded-[24px] px-6 sm:px-8 pt-4 pb-6 max-h-[85%] text-white shadow-[0_20px_60px_rgba(0,0,0,0.85)] animate-in zoom-in-95 duration-150 flex flex-col"
          >
            {/* Pull Bar Handle */}
            <div className="w-12 h-1 bg-white/20 rounded-full mx-auto mb-3.5 shrink-0" />

            {/* Header: Title on Left, Apply Button on Right */}
            <div className="flex items-center justify-between gap-4 mb-3.5 shrink-0">
              <h3 className="text-lg sm:text-xl font-bold text-white tracking-tight">
                Video Quality
              </h3>

              <button
                onClick={() => {
                  setActiveDrawer(null);
                  const currentSrvName = SERVER_METADATA[selectedServer]?.name || 'Anikoto';
                  showToast(`Applied: ${selectedQuality.replace(' (HLS)', '')} • ${currentSrvName}`);
                }}
                className="h-9 px-5 rounded-[12px] bg-[#a755f7] hover:bg-[#b86df9] text-white text-xs sm:text-[13px] font-bold transition-all cursor-pointer active:scale-95 flex items-center justify-center shadow-[0_2px_12px_rgba(167,85,247,0.35)]"
              >
                Apply
              </button>
            </div>

            {/* 2-Column Side-by-Side Content with Ultra-Thin Divider and Individual Scrollbars */}
            <div className="grid grid-cols-2 gap-4 sm:gap-6 pt-1 min-h-0">
              {/* LEFT COLUMN: QUALITY */}
              <div className="flex flex-col min-w-0 pr-3 sm:pr-4 border-r border-white/10">
                <span className="block text-[11px] font-bold text-white/50 tracking-wider uppercase mb-2 shrink-0">
                  QUALITY
                </span>

                <div className="space-y-2 overflow-y-auto max-h-52 sm:max-h-60 pr-1.5 scrollbar-thin scrollbar-thumb-white/20 overscroll-contain">
                  {/* Only real quality options provided by the active server / HLS manifest */}
                  {availableQualities.map((qOption) => {
                    const isAuto = qOption.includes('Auto');
                    const displayLabel = isAuto
                      ? activeAutoHeight && selectedQuality.includes('Auto')
                        ? `Auto (${activeAutoHeight}p)`
                        : 'Auto'
                      : qOption;
                    const isSelected = isAuto
                      ? selectedQuality.includes('Auto')
                      : selectedQuality.toLowerCase() === qOption.toLowerCase();

                    return (
                      <div
                        key={qOption}
                        onClick={() => handleQualityChange(qOption)}
                        className={`h-11 sm:h-12 px-4 rounded-xl border flex items-center justify-between transition-all cursor-pointer active:scale-98 select-none ${
                          isSelected
                            ? 'border-[#a855f7] bg-[#241335]/70 text-white'
                            : 'border-white/10 bg-[#0c0d12] text-white/80 hover:bg-white/5'
                        }`}
                      >
                        <span className="text-xs sm:text-sm font-semibold">{displayLabel}</span>
                        {isSelected && <Check className="w-4 h-4 text-[#a855f7]" />}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* RIGHT COLUMN: SERVERS */}
              <div className="flex flex-col min-w-0 pl-1 sm:pl-2">
                <span className="block text-[11px] font-bold text-white/50 tracking-wider uppercase mb-2 shrink-0">
                  SERVERS
                </span>

                <div className="space-y-2 overflow-y-auto max-h-52 sm:max-h-60 pr-1.5 scrollbar-thin scrollbar-thumb-white/20 overscroll-contain">
                  {ANIME_SERVER_ORDER.map((serverKey) => {
                    const meta = SERVER_METADATA[serverKey];
                    const isSelected = selectedServer === serverKey;

                    return (
                      <div
                        key={serverKey}
                        onClick={() => handleServerSelect(serverKey)}
                        className={`h-11 sm:h-12 px-4 rounded-xl border flex items-center justify-between transition-all cursor-pointer active:scale-98 select-none ${
                          isSelected
                            ? 'border-[#a855f7] bg-[#241335]/70 text-white'
                            : 'border-white/10 bg-[#0c0d12] text-white/80 hover:bg-white/5'
                        }`}
                      >
                        <div className="flex flex-col text-left">
                          <span className="text-xs sm:text-sm font-semibold text-white leading-tight">
                            {meta.name}
                          </span>
                          <span className="text-[10px] text-white/40 uppercase tracking-wider font-semibold leading-tight mt-0.5">
                            {meta.tag}
                          </span>
                        </div>
                        {isSelected && <Check className="w-4 h-4 text-[#a855f7]" />}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* DRAWER 4: PLAYBACK SPEED DRAWER */}
      {activeDrawer === 'speed' && (
        <div
          onClick={() => setActiveDrawer(null)}
          className="absolute inset-0 z-50 flex items-end justify-center p-3 sm:p-5 pb-3 sm:pb-5 bg-black/45 animate-in fade-in select-none"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-[94%] max-w-[540px] bg-[#0e0e11] border border-white/[0.06] rounded-[24px] px-5 sm:px-6 pt-3 pb-5 text-white shadow-[0_20px_60px_rgba(0,0,0,0.88)] animate-in zoom-in-95 duration-150 flex flex-col"
          >
            {/* Top Pull Bar Handle */}
            <div className="w-8 h-1 bg-white/30 rounded-full mx-auto mb-3 shrink-0" />

            {/* Header: Speed on Left, Active Value + Close (X) on Right */}
            <div className="flex items-center justify-between gap-4 mb-3 shrink-0">
              <h3 className="text-[17px] sm:text-[19px] font-bold text-white tracking-tight">
                Speed
              </h3>

              <div className="flex items-center gap-3">
                <span className="text-[14px] sm:text-[15px] font-bold text-white tracking-tight">
                  {formatSpeedValue(currentSpeedNum)}
                </span>
                <button
                  type="button"
                  onClick={() => setActiveDrawer(null)}
                  className="p-1 text-white/90 hover:text-white transition-colors cursor-pointer active:scale-90"
                  aria-label="Close Speed"
                >
                  <X className="w-5 h-5 stroke-[2.2]" />
                </button>
              </div>
            </div>

            {/* Interactive Tick-Mark Ruler Scrubber Row (- Button | Ruler | + Button) */}
            <div className="flex items-center gap-2.5 sm:gap-3 my-2">
              {/* Minus (-0.05x) Button */}
              <button
                type="button"
                disabled={currentSpeedNum <= 0.25}
                onClick={() => {
                  const next = Math.max(0.25, Math.round((currentSpeedNum - 0.05) * 20) / 20);
                  setPlaybackSpeed(`${next.toFixed(2)}x`);
                }}
                className={`w-10 h-10 rounded-full bg-[#19191e] flex items-center justify-center shrink-0 transition-all ${
                  currentSpeedNum <= 0.25
                    ? 'text-white/30 cursor-not-allowed'
                    : 'text-white hover:bg-[#24242b] active:scale-90 cursor-pointer'
                }`}
                aria-label="Decrease Speed"
              >
                <Minus className="w-4 h-4 stroke-[2.6]" />
              </button>

              {/* Center Interactive Ruler Scrubber */}
              <div
                onPointerDown={(e) => {
                  e.stopPropagation();
                  e.currentTarget.setPointerCapture(e.pointerId);
                  const coords = getLocalPlayerCoords(e.clientX, e.clientY);
                  speedRulerDragRef.current = {
                    pointerId: e.pointerId,
                    startVisualX: coords.x,
                    startSpeed: currentSpeedNum,
                    moved: false,
                  };
                  setIsDraggingSpeedRuler(true);
                }}
                onPointerMove={(e) => {
                  const drag = speedRulerDragRef.current;
                  if (!drag || drag.pointerId !== e.pointerId) return;
                  const coords = getLocalPlayerCoords(e.clientX, e.clientY);
                  const dx = coords.x - drag.startVisualX;
                  if (Math.abs(dx) > 3) drag.moved = true;
                  const rawSpeed = drag.startSpeed - (dx / 12) * 0.05;
                  const snapped = Math.min(3.0, Math.max(0.25, Math.round(rawSpeed * 20) / 20));
                  setPlaybackSpeed(`${snapped.toFixed(2)}x`);
                }}
                onPointerUp={(e) => {
                  const drag = speedRulerDragRef.current;
                  if (!drag || drag.pointerId !== e.pointerId) return;
                  speedRulerDragRef.current = null;
                  setIsDraggingSpeedRuler(false);
                  if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                    e.currentTarget.releasePointerCapture(e.pointerId);
                  }
                  if (!drag.moved) {
                    const rect = e.currentTarget.getBoundingClientRect();
                    const tapCoords = getLocalPlayerCoords(e.clientX, e.clientY);
                    const centerCoords = getLocalPlayerCoords(
                      rect.left + rect.width / 2,
                      rect.top + rect.height / 2
                    );
                    const deltaPx = tapCoords.x - centerCoords.x;
                    const tapped = Math.min(
                      3.0,
                      Math.max(0.25, Math.round((currentSpeedNum + (deltaPx / 12) * 0.05) * 20) / 20)
                    );
                    setPlaybackSpeed(`${tapped.toFixed(2)}x`);
                  }
                }}
                onPointerCancel={(e) => {
                  const drag = speedRulerDragRef.current;
                  if (drag && drag.pointerId === e.pointerId) {
                    speedRulerDragRef.current = null;
                    setIsDraggingSpeedRuler(false);
                  }
                }}
                className="relative flex-1 h-14 overflow-hidden cursor-ew-resize touch-none select-none"
                style={{
                  maskImage:
                    'linear-gradient(to right, transparent 0%, black 12%, black 88%, transparent 100%)',
                  WebkitMaskImage:
                    'linear-gradient(to right, transparent 0%, black 12%, black 88%, transparent 100%)',
                }}
              >
                {/* Fixed Center Active Pill + Glowing Purple Bar */}
                <div className="absolute left-1/2 -translate-x-1/2 top-0.5 w-8 h-9 rounded-[11px] bg-[#1a1822]/95 border border-white/5 flex items-center justify-center pointer-events-none z-10">
                  <div className="w-[4px] h-6 rounded-full bg-[#8b5cf6] shadow-[0_0_12px_rgba(139,92,246,0.9)]" />
                </div>

                {/* Scrolling Tick Marks & Major Speed Labels */}
                <div
                  className={`absolute left-1/2 top-0 h-full pointer-events-none ${
                    isDraggingSpeedRuler ? '' : 'transition-transform duration-150 ease-out'
                  }`}
                  style={{
                    transform: `translateX(${-((currentSpeedNum - 0.25) / 0.05) * 12}px)`,
                  }}
                >
                  {speedTickValues.map((tickVal, idx) => {
                    const isMajor = Math.round(tickVal * 100) % 25 === 0;
                    const isSelected = Math.abs(tickVal - currentSpeedNum) < 0.001;
                    return (
                      <div
                        key={tickVal}
                        className="absolute top-0 flex flex-col items-center"
                        style={{
                          left: `${idx * 12}px`,
                          transform: 'translateX(-50%)',
                        }}
                      >
                        <div className="h-9 flex items-center justify-center">
                          <div
                            className={`rounded-full ${
                              isMajor
                                ? `w-[2px] h-[18px] ${isSelected ? 'bg-transparent' : 'bg-white/55'}`
                                : 'w-[1.5px] h-[9px] bg-white/25'
                            }`}
                          />
                        </div>
                        {isMajor && (
                          <span
                            className={`text-[11px] leading-none whitespace-nowrap mt-1 ${
                              isSelected ? 'text-white font-semibold' : 'text-white/45 font-medium'
                            }`}
                          >
                            {formatSpeedValue(tickVal)}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Plus (+0.05x) Button */}
              <button
                type="button"
                disabled={currentSpeedNum >= 3.0}
                onClick={() => {
                  const next = Math.min(3.0, Math.round((currentSpeedNum + 0.05) * 20) / 20);
                  setPlaybackSpeed(`${next.toFixed(2)}x`);
                }}
                className={`w-10 h-10 rounded-full bg-[#19191e] flex items-center justify-center shrink-0 transition-all ${
                  currentSpeedNum >= 3.0
                    ? 'text-white/30 cursor-not-allowed'
                    : 'text-white hover:bg-[#24242b] active:scale-90 cursor-pointer'
                }`}
                aria-label="Increase Speed"
              >
                <Plus className="w-4 h-4 stroke-[2.6]" />
              </button>
            </div>

            {/* Bottom Preset Speed Pills Row */}
            <div className="flex items-center justify-between gap-1.5 sm:gap-2 mt-3 overflow-x-auto no-scrollbar">
              {speedPresetValues.map((preset) => {
                const isSelected = Math.abs(currentSpeedNum - preset) < 0.001;
                return (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setPlaybackSpeed(`${preset.toFixed(2)}x`)}
                    className={`flex-1 min-w-[44px] h-9 sm:h-10 px-2 rounded-full text-xs sm:text-[13px] font-bold flex items-center justify-center transition-all cursor-pointer active:scale-95 shrink-0 ${
                      isSelected
                        ? 'bg-[#381c5a] border border-[#9333ea] text-white shadow-[0_0_12px_rgba(147,51,234,0.28)]'
                        : 'bg-[#16161b] hover:bg-[#202028] border border-transparent text-white/90'
                    }`}
                  >
                    {formatSpeedValue(preset)}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* DRAWER 5: PLAYER SETTINGS DRAWER */}
      {activeDrawer === 'settings' && (
        <div
          onClick={() => setActiveDrawer(null)}
          className="absolute inset-0 z-50 flex items-end justify-center p-3 sm:p-5 pb-3 sm:pb-5 bg-black/40 animate-in fade-in select-none"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-[94%] max-w-[850px] bg-[#000000] border border-white/10 rounded-[24px] px-6 sm:px-8 pt-4 pb-6 max-h-[85%] text-white shadow-[0_20px_60px_rgba(0,0,0,0.85)] animate-in zoom-in-95 duration-150 flex flex-col"
          >
            {/* Pull Bar Handle */}
            <div className="w-12 h-1 bg-white/20 rounded-full mx-auto mb-3.5 shrink-0" />

            {/* Header */}
            <div className="flex items-center justify-between gap-4 mb-4 shrink-0">
              <h3 className="text-lg sm:text-xl font-bold text-white tracking-tight">
                Player Settings
              </h3>
              <button
                onClick={() => setActiveDrawer(null)}
                className="h-9 px-5 rounded-[12px] bg-[#a755f7] hover:bg-[#b86df9] text-white text-xs sm:text-[13px] font-bold transition-all cursor-pointer active:scale-95 flex items-center justify-center shadow-[0_2px_12px_rgba(167,85,247,0.35)]"
              >
                Done
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 overflow-y-auto pr-1">
              {/* Ambient Light */}
              <button
                type="button"
                onClick={() => {
                  const next = !ambientLightEnabled;
                  setAmbientLightEnabled(next);
                  showToast(next ? 'Ambient Light: On' : 'Ambient Light: Off');
                }}
                className={`h-12 px-4 rounded-xl border flex items-center justify-between transition-all cursor-pointer active:scale-98 ${
                  ambientLightEnabled
                    ? 'border-[#a855f7] bg-[#241335]/70 text-white'
                    : 'border-white/10 bg-[#0c0d12] text-white/80 hover:bg-white/5'
                }`}
              >
                <span className="text-xs sm:text-sm font-semibold">Ambient Light</span>
                <span className={`text-xs font-bold ${ambientLightEnabled ? 'text-[#b876fc]' : 'text-white/40'}`}>
                  {ambientLightEnabled ? 'ON' : 'OFF'}
                </span>
              </button>

              {/* Video Frame Fit */}
              <button
                type="button"
                onClick={() => toggleVideoFrameZoom()}
                className={`h-12 px-4 rounded-xl border flex items-center justify-between transition-all cursor-pointer active:scale-98 ${
                  isVideoFrameZoomed
                    ? 'border-[#a855f7] bg-[#241335]/70 text-white'
                    : 'border-white/10 bg-[#0c0d12] text-white/80 hover:bg-white/5'
                }`}
              >
                <span className="text-xs sm:text-sm font-semibold">Video Frame</span>
                <span className={`text-xs font-bold ${isVideoFrameZoomed ? 'text-[#b876fc]' : 'text-white/50'}`}>
                  {isVideoFrameZoomed ? 'Full Screen' : 'Normal'}
                </span>
              </button>

              {/* Landscape Rotation */}
              <button
                type="button"
                onClick={toggleLandscapeRotation}
                className={`h-12 px-4 rounded-xl border flex items-center justify-between transition-all cursor-pointer active:scale-98 ${
                  landscapeFirst
                    ? 'border-[#a855f7] bg-[#241335]/70 text-white'
                    : 'border-white/10 bg-[#0c0d12] text-white/80 hover:bg-white/5'
                }`}
              >
                <span className="text-xs sm:text-sm font-semibold">Orientation Mode</span>
                <span className={`text-xs font-bold ${landscapeFirst ? 'text-[#b876fc]' : 'text-white/50'}`}>
                  {landscapeFirst ? 'Landscape' : 'Auto'}
                </span>
              </button>

              {/* Quality & Server */}
              <button
                type="button"
                onClick={() => setActiveDrawer('quality')}
                className="h-12 px-4 rounded-xl border border-white/10 bg-[#0c0d12] text-white/85 hover:bg-white/5 flex items-center justify-between transition-all cursor-pointer active:scale-98"
              >
                <span className="text-xs sm:text-sm font-semibold">Quality & Server</span>
                <span className="text-xs font-semibold text-white/50">
                  {selectedQuality.replace(' (HLS)', '')}
                </span>
              </button>

              {/* Playback Speed */}
              <button
                type="button"
                onClick={() => setActiveDrawer('speed')}
                className="h-12 px-4 rounded-xl border border-white/10 bg-[#0c0d12] text-white/85 hover:bg-white/5 flex items-center justify-between transition-all cursor-pointer active:scale-98"
              >
                <span className="text-xs sm:text-sm font-semibold">Playback Speed</span>
                <span className="text-xs font-semibold text-white/50">{playbackSpeed}</span>
              </button>

              {/* Subtitles & Audio */}
              <button
                type="button"
                onClick={() => setActiveDrawer('subtitles')}
                className="h-12 px-4 rounded-xl border border-white/10 bg-[#0c0d12] text-white/85 hover:bg-white/5 flex items-center justify-between transition-all cursor-pointer active:scale-98"
              >
                <span className="text-xs sm:text-sm font-semibold">Subtitles & Audio</span>
                <span className="text-xs font-semibold text-white/50">{selectedSubtitle}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
