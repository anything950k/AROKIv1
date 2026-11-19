import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';

const execFileAsync = promisify(execFile);

export interface SourceModuleSpec {
  slug: string;
  name: string;
  type: 'manga' | 'novel' | 'anime';
}

export type AnimeServerKey =
  | 'anikoto'
  | 'anikage'
  | 'miruro'
  | 'justanime'
  | 'kickassanime';

export interface AnimeSourceSpec {
  slug: string;
  serverKey: AnimeServerKey;
  name: string;
  tag: string;
}

export const MANGA_SOURCE_MODULES: SourceModuleSpec[] = [
  { slug: 'atsu', name: 'Atsu', type: 'manga' },
  { slug: 'chikari', name: 'Chikari', type: 'manga' },
  { slug: 'asura-scans', name: 'Asura Scans', type: 'manga' },
  { slug: 'weebcentral', name: 'WeebCentral', type: 'manga' },
  { slug: 'mangabuddy', name: 'MangaBuddy', type: 'manga' },
  { slug: 'mangakatana', name: 'MangaKatana', type: 'manga' },
  { slug: 'synthetiq-manga', name: 'SynManga', type: 'manga' },
];

export const NOVEL_SOURCE_MODULE: SourceModuleSpec = {
  slug: 'lnori',
  name: 'Lnori',
  type: 'novel',
};

// Strict Anime Priority Hierarchy: Primary = Anikoto -> Fallback 1..4
export const ANIME_SOURCE_MODULES: AnimeSourceSpec[] = [
  { slug: 'anikoto-v4', serverKey: 'anikoto', name: 'Anikoto', tag: 'Primary Source' },
  { slug: 'anikage-v1', serverKey: 'anikage', name: 'Anikage', tag: 'Fallback 1' },
  { slug: 'miruro-v3', serverKey: 'miruro', name: 'Miruro', tag: 'Fallback 2' },
  { slug: 'justanime-v1', serverKey: 'justanime', name: 'JustAnime', tag: 'Fallback 3' },
  { slug: 'kickassanime-v3', serverKey: 'kickassanime', name: 'KickAssAnime', tag: 'Fallback 4' },
];

const ALL_SOURCE_SLUGS = new Set([
  ...MANGA_SOURCE_MODULES.map((m) => m.slug),
  NOVEL_SOURCE_MODULE.slug,
  ...ANIME_SOURCE_MODULES.map((m) => m.slug),
]);

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

interface CookieJar {
  host: string;
  values: Map<string, string>;
}

const moduleRuntimeCache = new Map<string, Promise<any>>();

function updateCookieJar(response: Response, requestURL: URL, jar: CookieJar) {
  if (!jar || !requestURL || requestURL.hostname.toLowerCase() !== jar.host) return;
  const headersAny = response.headers as any;
  const setCookies: string[] =
    typeof headersAny.getSetCookie === 'function' ? headersAny.getSetCookie() : [];
  for (const setCookie of setCookies) {
    const pair = String(setCookie).split(';', 1)[0];
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (!name) continue;
    if (/max-age\s*=\s*0/i.test(setCookie)) jar.values.delete(name);
    else jar.values.set(name, value);
  }
}

async function curlNetworkResponse(
  url: string,
  headers: Record<string, string> = {},
  method = 'GET',
  body: any = null,
  options: any = {}
) {
  const started = Date.now();
  const args = ['-s', '-L', '-w', '\n__STATUS__:%{http_code}\n__FINALURL__:%{url_effective}'];
  if (method && method.toUpperCase() !== 'GET') {
    args.push('-X', method.toUpperCase());
  }

  let hasUA = false;
  let hasRef = false;
  if (headers) {
    for (const [k, v] of Object.entries(headers)) {
      if (!v) continue;
      const lower = k.toLowerCase();
      if (lower === 'user-agent') hasUA = true;
      if (lower === 'referer') hasRef = true;
      args.push('-H', `${k}: ${v}`);
    }
  }
  if (!hasUA) args.push('-H', `User-Agent: ${DEFAULT_UA}`);
  if (!hasRef) {
    try {
      const u = new URL(url);
      args.push('-H', `Referer: ${u.protocol}//${u.host}/`);
    } catch {}
  }

  if (body) {
    const bodyStr =
      typeof body === 'object' && !(body instanceof Uint8Array)
        ? JSON.stringify(body)
        : String(body);
    args.push('--data-raw', bodyStr);
  }

  args.push(url);
  const timeoutMs = Math.max(10_000, Number(options.timeoutMilliseconds) || 25_000);
  const { stdout } = await execFileAsync('curl', args, {
    maxBuffer: 32 * 1024 * 1024,
    timeout: timeoutMs,
  });

  const marker = '\n__STATUS__:';
  const idx = stdout.lastIndexOf(marker);
  let status = 200;
  let finalUrl = url;
  let textBody = stdout;
  if (idx !== -1) {
    textBody = stdout.slice(0, idx);
    const metaPart = stdout.slice(idx + marker.length);
    const [statusStr, finalUrlLine] = metaPart.split('\n__FINALURL__:');
    status = parseInt(statusStr.trim(), 10) || 200;
    if (finalUrlLine) finalUrl = finalUrlLine.trim();
  }

  const bytes = Buffer.from(textBody, 'utf8');
  const limit = Number(options.maxBytesHint) || 16 * 1024 * 1024;
  const dropped = bytes.length > limit;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {},
    finalUrl,
    body: dropped ? '' : textBody,
    bodyDropped: dropped,
    dropReason: dropped ? 'maxBytesHint' : null,
    bodyBytes: bytes.length,
    bodyMagicHex: bytes.slice(0, 16).toString('hex'),
    contentType:
      textBody.startsWith('{') || textBody.startsWith('[') ? 'application/json' : 'text/html',
    error: null,
    durationMs: Date.now() - started,
    text: async () => textBody,
    json: async () => JSON.parse(textBody),
  };
}

async function networkResponse(
  url: string,
  headers: Record<string, string> = {},
  method = 'GET',
  body: any = null,
  options: any = {}
) {
  const started = Date.now();
  const requestURL = new URL(url);
  const requestHeaders = new Headers(headers || {});
  if (!requestHeaders.has('User-Agent')) {
    requestHeaders.set('User-Agent', DEFAULT_UA);
  }

  if (
    options.implicitCookies !== false &&
    options.cookieJar &&
    requestURL.hostname.toLowerCase() === options.cookieJar.host &&
    !requestHeaders.has('Cookie')
  ) {
    const cookieHeader = [...options.cookieJar.values.entries()]
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
    if (cookieHeader) requestHeaders.set('Cookie', cookieHeader);
  }

  // atsu.moe blocks Node/undici TLS fingerprints; use curl directly
  if (requestURL.hostname.includes('atsu.moe')) {
    return await curlNetworkResponse(url, headers, method, body, options);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: requestHeaders,
      body: body
        ? typeof body === 'object' && !(body instanceof Uint8Array)
          ? JSON.stringify(body)
          : body
        : null,
      redirect: options.followRedirects === false ? 'manual' : 'follow',
      signal: AbortSignal.timeout(
        Math.max(10_000, Number(options.timeoutMilliseconds) || 25_000)
      ),
    });
  } catch (err) {
    return await curlNetworkResponse(url, headers, method, body, options);
  }

  if (response.status === 403 || response.status === 503) {
    try {
      const curlRes = await curlNetworkResponse(url, headers, method, body, options);
      if (curlRes.ok) return curlRes;
    } catch {}
  }

  if (options.cookieJar) {
    updateCookieJar(response, requestURL, options.cookieJar);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const limit = Number(options.maxBytesHint) || 16 * 1024 * 1024;
  const dropped = bytes.length > limit;
  const textBody = dropped ? '' : new TextDecoder().decode(bytes);
  return {
    status: response.status,
    ok: response.ok,
    headers: Object.fromEntries(response.headers.entries()),
    finalUrl: response.url,
    body: textBody,
    bodyDropped: dropped,
    dropReason: dropped ? 'maxBytesHint' : null,
    bodyBytes: bytes.length,
    bodyMagicHex: Buffer.from(bytes.slice(0, 16)).toString('hex'),
    contentType: response.headers.get('content-type') || '',
    error: null,
    durationMs: Date.now() - started,
    text: async () => textBody,
    json: async () => JSON.parse(textBody),
  };
}

async function getModuleRuntime(slug: string): Promise<any> {
  if (!ALL_SOURCE_SLUGS.has(slug)) {
    throw new Error(`Unsupported source module: ${slug}`);
  }

  const cached = moduleRuntimeCache.get(slug);
  if (cached) return cached;

  const loader = (async () => {
    const filePath = path.join(process.cwd(), 'modules', slug, 'index.js');
    const source = await fs.readFile(filePath, 'utf8');
    const cookieJar: CookieJar = { host: '', values: new Map() };

    const customFetch = async (input: any, opts: any = {}) => {
      const url = typeof input === 'string' ? input : String(input?.url || input || '');
      const hdrs = new Headers(opts?.headers || {});
      if (!hdrs.has('User-Agent')) {
        hdrs.set(
          'User-Agent',
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'
        );
      }
      const method = String(opts?.method || 'GET').toUpperCase();
      let reqBody = opts?.body;
      if (
        reqBody &&
        typeof reqBody === 'object' &&
        !(reqBody instanceof Buffer) &&
        !(reqBody instanceof Uint8Array)
      ) {
        reqBody = JSON.stringify(reqBody);
        if (!hdrs.has('Content-Type')) {
          hdrs.set('Content-Type', 'application/json');
        }
      }
      const signal = opts?.signal || AbortSignal.timeout(20_000);
      const nativeRes = await fetch(url, {
        ...opts,
        method,
        headers: hdrs,
        body: method === 'GET' || method === 'HEAD' ? undefined : reqBody || undefined,
        signal,
      });
      const buffer = await nativeRes.arrayBuffer();
      const textBody = Buffer.from(buffer).toString('utf8');
      let parsedJson: any = null;
      try {
        parsedJson = JSON.parse(textBody);
      } catch {
        parsedJson = null;
      }
      return {
        status: nativeRes.status,
        ok: nativeRes.ok,
        statusText: nativeRes.statusText,
        url: nativeRes.url,
        headers: nativeRes.headers,
        body: textBody,
        text: async () => textBody,
        json: async () => {
          if (parsedJson !== null) return parsedJson;
          return JSON.parse(textBody);
        },
        arrayBuffer: async () => buffer,
      };
    };

    const bridges = {
      fetch: customFetch,
      fetchv2: async (
        url: string,
        headers: Record<string, string> = {},
        method = 'GET',
        body: any = null,
        options: any = {}
      ) => {
        return await networkResponse(url, headers, method, body, {
          ...options,
          cookieJar,
          implicitCookies: false,
        });
      },
      pagev2: async (task: any) => {
        const response = await networkResponse(task.url, task.headers || {}, 'GET', null, {
          followRedirects: true,
          maxBytesHint: task.maxResponseCharacters || 1_000_000,
          timeoutMilliseconds: task.timeoutMilliseconds,
        });
        if (!response.ok || response.bodyDropped) {
          throw new Error(`pagev2 failed for ${task.url}`);
        }
        return {
          finalURL: response.finalUrl,
          title: '',
          html: task.includeHTML ? response.body : null,
          events: [],
          cookies: {},
          evaluatedData: response.body,
        };
      },
      reportProgress: async () => ({ ok: true }),
    };

    const sandboxConsole = {
      log: (...args: any[]) => {
        const msg = args.map((a) => String(a)).join(' ');
        if (msg.includes('probe failed') && msg.includes('not_hls')) return;
        console.log(...args);
      },
      warn: (...args: any[]) => {
        const msg = args.map((a) => String(a)).join(' ');
        if (msg.includes('probe failed') && msg.includes('not_hls')) return;
        console.warn(...args);
      },
      error: (...args: any[]) => console.error(...args),
      info: (...args: any[]) => console.info(...args),
    };

    const context: any = vm.createContext({
      Headers: globalThis.Headers,
      Request: globalThis.Request,
      Response: globalThis.Response,
      URL,
      URLSearchParams,
      atob: globalThis.atob,
      btoa: globalThis.btoa,
      crypto: globalThis.crypto,
      TextDecoder,
      TextEncoder,
      Uint8Array,
      Buffer,
      console: sandboxConsole,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      Promise,
      Array,
      Object,
      String,
      Number,
      Boolean,
      Date,
      Math,
      JSON,
      RegExp,
      Error,
      Map,
      Set,
      ...bridges,
    });
    context.globalThis = context;
    context.window = context;
    new vm.Script(source, { filename: `modules/${slug}/index.js` }).runInContext(context);

    if (typeof context.SynthetiqModule === 'object') {
      return context.SynthetiqModule;
    }

    if (
      typeof context.searchResults === 'function' ||
      typeof context.extractEpisodes === 'function' ||
      typeof context.extractStreamUrl === 'function'
    ) {
      return {
        searchResults: context.searchResults,
        extractDetails: context.extractDetails,
        extractEpisodes: context.extractEpisodes,
        extractStreamUrl: context.extractStreamUrl,
      };
    }

    throw new Error(`Module ${slug} did not export SynthetiqModule or global module functions`);
  })().catch((err) => {
    moduleRuntimeCache.delete(slug);
    throw err;
  });

  moduleRuntimeCache.set(slug, loader);
  return loader;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function normalizeTitleText(value: string): string {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripEditionSuffix(value: string): string {
  return String(value || '')
    .replace(/\s*[\(\[](?:official|colored|digital|manga|manhwa|manhua|webtoon|light novel|novel|raw)[\)\]]/gi, '')
    .trim();
}

function compactAlnum(value: string): string {
  return normalizeTitleText(value).replace(/\s+/g, '');
}

const SPINOFF_MARKERS = [
  'ragnarok',
  'side story',
  'spin off',
  'spinoff',
  'anthology',
  'doujinshi',
  'fanbook',
  'databook',
  'novel',
  'parody',
  'after story',
  'sequel',
];

function scoreSeriesMatch(candidateTitle: string, targetTitles: string[]): number {
  const candClean = stripEditionSuffix(candidateTitle);
  const candNorm = normalizeTitleText(candClean);
  const candCompact = compactAlnum(candClean);
  if (!candNorm || !candCompact) return 0;

  const candTokens = candNorm.split(' ').filter(Boolean);
  let bestScore = 0;

  for (let i = 0; i < targetTitles.length; i++) {
    const rawTarget = targetTitles[i];
    const targetClean = stripEditionSuffix(rawTarget);
    const targetNorm = normalizeTitleText(targetClean);
    const targetCompact = compactAlnum(targetClean);
    if (!targetNorm || !targetCompact) continue;

    // Slight priority boost for primary English / main titles over distant synonyms
    const priorityPenalty = Math.min(i, 4) * 0.5;

    if (candNorm === targetNorm) {
      bestScore = Math.max(bestScore, 100 - priorityPenalty);
      continue;
    }
    if (candCompact === targetCompact) {
      bestScore = Math.max(bestScore, 96 - priorityPenalty);
      continue;
    }

    const targetTokens = targetNorm.split(' ').filter(Boolean);
    const candSet = new Set(candTokens);
    const targetSet = new Set(targetTokens);

    let overlap = 0;
    for (const t of targetSet) {
      if (candSet.has(t)) overlap++;
    }

    if (overlap === 0) continue;

    const targetCoverage = overlap / targetSet.size;
    const candCoverage = overlap / candSet.size;

    // Guard against matching a sequel/spin-off (e.g. "Solo Leveling: Ragnarok") for "Solo Leveling"
    let spinoffPenalty = 0;
    for (const marker of SPINOFF_MARKERS) {
      if (candNorm.includes(marker) && !targetNorm.includes(marker)) {
        spinoffPenalty = 45;
        break;
      }
    }

    // Also guard against extra subtitles when target doesn't have them
    if (
      targetSet.size >= 2 &&
      candTokens.length > targetTokens.length &&
      candNorm.startsWith(targetNorm)
    ) {
      const extraRatio = (candTokens.length - targetTokens.length) / targetTokens.length;
      if (extraRatio >= 0.4 && spinoffPenalty === 0) {
        spinoffPenalty = 22;
      }
    }

    const baseScore = (targetCoverage * 55 + candCoverage * 40) - spinoffPenalty - priorityPenalty;
    bestScore = Math.max(bestScore, baseScore);
  }

  return bestScore;
}

function buildSearchQueries(title: string, altTitles: string[] = []): {
  matchTargets: string[];
  searchQueries: string[];
} {
  const allRaw = [title, ...altTitles]
    .map((t) => String(t || '').trim())
    .filter((t) => t.length >= 2);

  // Deduplicate case-insensitively while preserving order
  const seen = new Set<string>();
  const matchTargets: string[] = [];
  for (const t of allRaw) {
    const key = normalizeTitleText(t);
    if (key && !seen.has(key)) {
      seen.add(key);
      matchTargets.push(t);
    }
    // Also add base before colon if long title has subtitle
    if (t.includes(': ')) {
      const prefix = t.split(': ')[0].trim();
      const prefixKey = normalizeTitleText(prefix);
      if (prefix.length >= 4 && prefixKey && !seen.has(prefixKey)) {
        seen.add(prefixKey);
        matchTargets.push(prefix);
      }
    }
  }

  // Pick up to 2 distinct Latin/ASCII search queries for network efficiency
  const searchQueries: string[] = [];
  const querySeen = new Set<string>();
  for (const t of [title, ...altTitles]) {
    const clean = stripEditionSuffix(String(t || '').trim());
    if (!clean || clean.length < 2) continue;
    // Prefer queries with Latin letters
    if (!/[a-zA-Z0-9]/.test(clean)) continue;
    const key = clean.toLowerCase();
    if (!querySeen.has(key)) {
      querySeen.add(key);
      searchQueries.push(clean);
      if (searchQueries.length >= 2) break;
    }
  }

  if (searchQueries.length === 0 && title) {
    searchQueries.push(title);
  }

  return { matchTargets, searchQueries };
}

function pickBestMatch(items: any[], matchTargets: string[]) {
  let best: { item: any; score: number } | null = null;
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || !item.id || !item.title) continue;
    const score = scoreSeriesMatch(String(item.title), matchTargets);
    if (score >= 72 && (!best || score > best.score)) {
      best = { item, score };
    }
  }
  return best;
}

function parseChapterNumber(rawNum: any, rawTitle: string): number | null {
  if (rawNum !== null && rawNum !== undefined && rawNum !== '') {
    const n = Number(rawNum);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const m = String(rawTitle || '').match(/(?:chapter|chap|ch\.?|episode|ep\.?)\s*#?:?-?\s*(\d+(?:\.\d+)?)/i);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

function formatCleanChapterTitle(
  sourceName: string,
  scanlationGroup: string | undefined,
  rawTitle: string,
  chNum: number
): string {
  const label = scanlationGroup ? `${sourceName} • ${scanlationGroup}` : sourceName;
  let sub = String(rawTitle || '').trim();
  // Strip redundant leading "Chapter 123", "Ch. 123:", "Chapter 123 - "
  const numEscaped = String(chNum).replace('.', '\\.');
  sub = sub
    .replace(new RegExp(`^(?:chapter|chap|ch\\.?)\\s*0*${numEscaped}\\s*[:\\-–—]?\\s*`, 'i'), '')
    .trim();
  if (!sub || sub.toLowerCase() === `chapter ${chNum}`) {
    return label;
  }
  return `${label} — ${sub}`;
}

export function buildImageProxyUrl(rawUrl: string, referer?: string): string {
  if (!rawUrl) return '';
  let url = `/api/image-proxy?url=${encodeURIComponent(rawUrl)}`;
  if (referer) {
    url += `&referer=${encodeURIComponent(referer)}`;
  }
  return url;
}

export function inferRefererForUrl(targetUrl: string, explicitReferer?: string): string {
  if (explicitReferer) return explicitReferer;
  const lower = targetUrl.toLowerCase();
  if (lower.includes('atsu.moe')) return 'https://atsu.moe/';
  if (lower.includes('chikari.moe')) return 'https://chikari.moe/';
  if (lower.includes('asurascans') || lower.includes('asura-images') || lower.includes('asuracomic')) {
    return 'https://asurascans.com/';
  }
  if (
    lower.includes('weebcentral') ||
    lower.includes('compsci88') ||
    lower.includes('planeptune') ||
    lower.includes('lastation') ||
    lower.includes('lowee')
  ) {
    return 'https://weebcentral.com/';
  }
  if (lower.includes('cmzcdn.org') || lower.includes('comizy')) return 'https://comizy.io/';
  if (lower.includes('mangakatana')) return 'https://mangakatana.com/';
  if (lower.includes('lnori.com')) return 'https://lnori.com/';
  try {
    const u = new URL(targetUrl);
    return `${u.protocol}//${u.host}/`;
  } catch {
    return '';
  }
}

export async function proxyImageRequest(
  targetUrl: string,
  explicitReferer?: string
): Promise<{ buffer: Buffer; contentType: string; status?: number }> {
  const referer = inferRefererForUrl(targetUrl, explicitReferer);
  const lower = targetUrl.toLowerCase();
  const headers: Record<string, string> = {
    'User-Agent': DEFAULT_UA,
    Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
  };
  if (referer) headers['Referer'] = referer;

  const guessContentType = (headerType?: string | null) => {
    if (headerType && headerType.startsWith('image/')) return headerType;
    if (lower.includes('.webp')) return 'image/webp';
    if (lower.includes('.png')) return 'image/png';
    if (lower.includes('.avif')) return 'image/avif';
    if (lower.includes('.gif')) return 'image/gif';
    return 'image/jpeg';
  };

  if (lower.includes('atsu.moe')) {
    const { stdout } = await execFileAsync(
      'curl',
      ['-s', '-L', '-A', DEFAULT_UA, '-H', `Referer: ${referer || 'https://atsu.moe/'}`, targetUrl],
      { encoding: 'buffer', maxBuffer: 25 * 1024 * 1024, timeout: 20_000 }
    );
    if (stdout && stdout.length > 0) {
      return { buffer: stdout, contentType: guessContentType() };
    }
  }

  let upstream: Response | null = null;
  try {
    upstream = await fetch(targetUrl, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {}

  if (!upstream || !upstream.ok) {
    try {
      const { stdout } = await execFileAsync(
        'curl',
        ['-s', '-L', '-A', DEFAULT_UA, '-H', `Referer: ${referer || targetUrl}`, targetUrl],
        { encoding: 'buffer', maxBuffer: 25 * 1024 * 1024, timeout: 20_000 }
      );
      if (stdout && stdout.length > 0) {
        return { buffer: stdout, contentType: guessContentType() };
      }
    } catch {}
    return {
      buffer: Buffer.alloc(0),
      contentType: 'text/plain',
      status: upstream ? upstream.status : 502,
    };
  }

  const ab = await upstream.arrayBuffer();
  return {
    buffer: Buffer.from(ab),
    contentType: guessContentType(upstream.headers.get('content-type')),
  };
}

export async function fetchAllMangaChapters(params: {
  title: string;
  altTitles?: string[];
}) {
  const { matchTargets, searchQueries } = buildSearchQueries(
    params.title,
    params.altTitles || []
  );

  // Query ALL 7 manga modules concurrently — zero primary or fallback suppression
  const results = await Promise.allSettled(
    MANGA_SOURCE_MODULES.map(async (spec, sourceOrder) => {
      const mod = await withTimeout(getModuleRuntime(spec.slug), 5000, `${spec.slug}:init`);
      let matchedSeries: any = null;

      for (const q of searchQueries) {
        try {
          const searchRes = await withTimeout<any>(
            mod.searchResults(q, 1),
            12_000,
            `${spec.slug}:search`
          );
          const best = pickBestMatch(searchRes?.items || [], matchTargets);
          if (best) {
            matchedSeries = best.item;
            break;
          }
        } catch {
          // Try alternate title query if available
        }
      }

      if (!matchedSeries) {
        return {
          slug: spec.slug,
          name: spec.name,
          matchedTitle: null as string | null,
          chapters: [] as any[],
        };
      }

      const rawChapters = await withTimeout<any[]>(
        mod.extractChapters(matchedSeries.id),
        18_000,
        `${spec.slug}:chapters`
      );

      const mapped = (Array.isArray(rawChapters) ? rawChapters : [])
        .map((ch) => {
          const chNum = parseChapterNumber(ch?.number ?? ch?.chapterNumber, ch?.title);
          if (chNum === null) return null;
          const rawId = String(ch.id || ch.url || ch.href || '').trim();
          if (!rawId) return null;
          const scanGroup = ch.scanlationGroup ? String(ch.scanlationGroup).trim() : undefined;
          const groupLabel = scanGroup ? `${spec.name} • ${scanGroup}` : spec.name;
          return {
            id: `${spec.slug}::${rawId}`,
            chapterNumber: chNum,
            title: formatCleanChapterTitle(spec.name, scanGroup, String(ch.title || ''), chNum),
            publishAt: ch.releaseDate || undefined,
            pages: Number(ch.pageCount) || undefined,
            scanlationGroup: groupLabel,
            _sourceOrder: sourceOrder,
          };
        })
        .filter(Boolean) as any[];

      return {
        slug: spec.slug,
        name: spec.name,
        matchedTitle: String(matchedSeries.title || ''),
        chapters: mapped,
      };
    })
  );

  const allChapters: any[] = [];
  const sourcesSummary: Array<{
    slug: string;
    name: string;
    matchedTitle: string | null;
    chapterCount: number;
    error?: string;
  }> = [];

  results.forEach((res, idx) => {
    const spec = MANGA_SOURCE_MODULES[idx];
    if (res.status === 'fulfilled') {
      allChapters.push(...res.value.chapters);
      sourcesSummary.push({
        slug: spec.slug,
        name: spec.name,
        matchedTitle: res.value.matchedTitle,
        chapterCount: res.value.chapters.length,
      });
    } else {
      sourcesSummary.push({
        slug: spec.slug,
        name: spec.name,
        matchedTitle: null,
        chapterCount: 0,
        error: res.reason?.message || 'Failed',
      });
    }
  });

  // Sort ascending by chapterNumber, then by source order, then by group name
  allChapters.sort((a, b) => {
    if (a.chapterNumber !== b.chapterNumber) return a.chapterNumber - b.chapterNumber;
    if (a._sourceOrder !== b._sourceOrder) return a._sourceOrder - b._sourceOrder;
    return String(a.scanlationGroup || '').localeCompare(String(b.scanlationGroup || ''));
  });

  const cleanChapters = allChapters.map(({ _sourceOrder, ...rest }) => rest);
  return {
    chapters: cleanChapters,
    total: cleanChapters.length,
    sourcesSummary,
  };
}

export async function fetchMangaChapterPages(chapterId: string): Promise<{
  pages: string[];
  sourceSlug: string;
}> {
  const raw = String(chapterId || '').trim();
  const sep = raw.indexOf('::');
  if (sep <= 0) {
    throw new Error('Missing or invalid source chapter identifier.');
  }
  const slug = raw.slice(0, sep);
  const moduleChapterId = raw.slice(sep + 2);
  if (!ALL_SOURCE_SLUGS.has(slug) || slug === NOVEL_SOURCE_MODULE.slug) {
    throw new Error(`Unsupported manga source slug: ${slug}`);
  }

  const mod = await getModuleRuntime(slug);
  const rawPages = await withTimeout<any[]>(
    mod.extractImages(moduleChapterId),
    20_000,
    `${slug}:images`
  );

  const pages = (Array.isArray(rawPages) ? rawPages : [])
    .map((entry) => {
      if (typeof entry === 'string') {
        return buildImageProxyUrl(entry, inferRefererForUrl(entry));
      }
      const url = String(entry?.url || entry?.src || '').trim();
      if (!url) return '';
      const referer = entry?.headers?.Referer || entry?.headers?.referer || inferRefererForUrl(url);
      return buildImageProxyUrl(url, referer);
    })
    .filter(Boolean);

  return { pages, sourceSlug: slug };
}

async function resolveLnoriSeries(title: string, altTitles: string[] = []) {
  const mod = await getModuleRuntime(NOVEL_SOURCE_MODULE.slug);
  const { matchTargets, searchQueries } = buildSearchQueries(title, altTitles);

  for (const q of searchQueries) {
    try {
      const searchRes = await withTimeout<any>(mod.searchResults(q, 1), 15_000, 'lnori:search');
      const best = pickBestMatch(searchRes?.items || [], matchTargets);
      if (best) return { mod, series: best.item };
    } catch {}

    // Fallback keyword search (first 2 significant words) if full title includes punctuation/subtitles
    const words = normalizeTitleText(q)
      .split(' ')
      .filter((w) => w.length >= 3);
    if (words.length >= 2) {
      const shortQ = words.slice(0, 2).join(' ');
      try {
        const searchRes = await withTimeout<any>(
          mod.searchResults(shortQ, 1),
          15_000,
          'lnori:search-short'
        );
        const best = pickBestMatch(searchRes?.items || [], matchTargets);
        if (best) return { mod, series: best.item };
      } catch {}
    }
  }

  return { mod, series: null };
}

export async function fetchLnoriNovelVolumes(params: {
  title: string;
  altTitles?: string[];
}) {
  const { mod, series } = await resolveLnoriSeries(params.title, params.altTitles || []);
  if (!series) {
    return { volumes: [], matchedTitle: null as string | null };
  }

  const rawVolumes = await withTimeout<any[]>(
    mod.extractChapters(series.id),
    15_000,
    'lnori:volumes'
  );

  const volumes = (Array.isArray(rawVolumes) ? rawVolumes : []).map((vol, idx) => {
    const volNum = Number(vol.volumeNumber || vol.number || idx + 1);
    const rawCover = String(vol.image || '').trim();
    return {
      id: `lnori::${String(vol.id || vol.href)}`,
      chapterNumber: volNum,
      volume: volNum,
      title: String(vol.title || `Volume ${volNum}`).trim(),
      coverImage: rawCover ? buildImageProxyUrl(rawCover, 'https://lnori.com/') : undefined,
      providerId: 'lnori',
    };
  });

  volumes.sort((a, b) => a.chapterNumber - b.chapterNumber);
  return {
    volumes,
    matchedTitle: String(series.title || ''),
  };
}

function cleanLnoriNovelText(extracted: any, fallbackVolume: number) {
  const title = String(extracted?.title || `Volume ${fallbackVolume}`).trim();
  const paragraphs: string[] = [];

  if (Array.isArray(extracted?.elements) && extracted.elements.length > 0) {
    for (const el of extracted.elements) {
      if (!el || typeof el !== 'object') continue;
      if (el.type === 'heading' && el.text) {
        paragraphs.push(`═════ ${String(el.text).trim()} ═════`);
      } else if (el.type === 'paragraph' && el.text) {
        const clean = String(el.text).trim();
        if (clean) paragraphs.push(clean);
      } else if (el.type === 'separator') {
        paragraphs.push('* * *');
      }
    }
  }

  if (paragraphs.length === 0 && extracted?.content) {
    const stripped = String(extracted.content)
      .replace(/\[\[ILLUSTRATION:[^\]]*\]\]/g, '')
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean);
    paragraphs.push(...stripped);
  }

  const content = paragraphs.join('\n\n').trim();
  return { title, content, paragraphs };
}

export async function fetchLnoriNovelChapterText(params: {
  readId?: string;
  chapterNumber: number;
  title?: string;
  altTitles?: string[];
}) {
  const mod = await getModuleRuntime(NOVEL_SOURCE_MODULE.slug);
  let targetBookId = '';

  const rawReadId = String(params.readId || '').trim();
  if (rawReadId.startsWith('lnori::')) {
    targetBookId = rawReadId.slice('lnori::'.length);
  } else if (rawReadId.startsWith('https://lnori.com/book/')) {
    targetBookId = rawReadId;
  } else if (params.title) {
    const resolved = await resolveLnoriSeries(params.title, params.altTitles || []);
    if (resolved.series) {
      const rawVolumes = await withTimeout<any[]>(
        mod.extractChapters(resolved.series.id),
        15_000,
        'lnori:volumes'
      );
      const list = Array.isArray(rawVolumes) ? rawVolumes : [];
      const match =
        list.find(
          (v) =>
            Number(v.volumeNumber) === params.chapterNumber ||
            Number(v.number) === params.chapterNumber
        ) || list[params.chapterNumber - 1];
      if (match?.id) {
        targetBookId = String(match.id);
      }
    }
  }

  if (!targetBookId) {
    return null;
  }

  const extracted = await withTimeout<any>(
    mod.extractText(targetBookId),
    20_000,
    'lnori:text'
  );
  const cleaned = cleanLnoriNovelText(extracted, params.chapterNumber);
  if (!cleaned.content) return null;

  return {
    chapterNumber: params.chapterNumber,
    title: cleaned.title,
    content: cleaned.content,
    paragraphs: cleaned.paragraphs,
    providerId: 'lnori',
  };
}

// -------------------------------------------------------------
// ANIME SOURCES (Strict Primary -> Fallback 1..4 Hierarchy)
// -------------------------------------------------------------

const ANIME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

interface CachedAnimeEpisodes {
  episodes: any[];
  timestamp: number;
}

const animeEpisodesCache = new Map<string, CachedAnimeEpisodes>();
const ANIME_EPISODES_CACHE_TTL = 15 * 60 * 1000;

function extractExplicitSeasonNumber(text: string): number | null {
  const s = normalizeTitleText(text);
  if (!s) return null;
  const ord = s.match(/\b(\d+)(?:st|nd|rd|th)\s+season\b/);
  if (ord) return parseInt(ord[1], 10);
  const explicit = s.match(/\b(?:season|s)\s*(\d+)\b/);
  if (explicit) return parseInt(explicit[1], 10);
  const trailingNum = s.match(/\b([2-9])\b$/);
  if (trailingNum && !/\bpart\s+[2-9]$/.test(s)) return parseInt(trailingNum[1], 10);
  if (/\bfinal\s+season\b/.test(s)) return 4;
  return null;
}

function pickBestAnimeMatch(items: any[], matchTargets: string[]) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return null;

  const targetSeasons = matchTargets
    .map((t) => extractExplicitSeasonNumber(t))
    .filter((n): n is number => n !== null);
  const desiredSeason = targetSeasons.length > 0 ? targetSeasons[0] : null;

  let best: { item: any; score: number } | null = null;
  for (const item of list) {
    if (!item || (!item.id && !item.href) || !item.title) continue;
    let score = scoreSeriesMatch(String(item.title), matchTargets);
    const candSeason = extractExplicitSeasonNumber(String(item.title));

    if (desiredSeason !== null) {
      if (candSeason === desiredSeason) score += 12;
      else if (candSeason !== null && candSeason !== desiredSeason) score -= 35;
      else if (desiredSeason > 1 && candSeason === null) score -= 18;
    } else if (candSeason !== null && candSeason > 1) {
      score -= 22;
    }

    if (score >= 68 && (!best || score > best.score)) {
      best = { item, score };
    }
  }
  return best;
}

function getDefaultHeadersForModule(serverKey: AnimeServerKey): Record<string, string> {
  switch (serverKey) {
    case 'anikoto':
      return { 'User-Agent': ANIME_UA, Referer: 'https://anikototv.to/', Origin: 'https://anikototv.to' };
    case 'anikage':
      return { 'User-Agent': ANIME_UA, Referer: 'https://anikage.cc/', Origin: 'https://anikage.cc' };
    case 'miruro':
      return { 'User-Agent': ANIME_UA, Referer: 'https://hianimes.ru/', Origin: 'https://hianimes.ru' };
    case 'justanime':
      return { 'User-Agent': ANIME_UA, Referer: 'https://justanime.to/', Origin: 'https://justanime.to' };
    case 'kickassanime':
      return { 'User-Agent': ANIME_UA, Referer: 'https://krussdomi.com/', Origin: 'https://krussdomi.com' };
  }
}

export function buildHlsProxyUrl(rawUrl: string, referer?: string, origin?: string): string {
  if (!rawUrl) return '';
  if (rawUrl.startsWith('/api/hls-proxy') || rawUrl.startsWith('/api/stream/proxy')) return rawUrl;
  let url = `/api/hls-proxy?url=${encodeURIComponent(rawUrl)}`;
  if (referer) url += `&referer=${encodeURIComponent(referer)}`;
  if (origin) url += `&origin=${encodeURIComponent(origin)}`;
  return url;
}

export function buildSubtitleProxyUrl(rawUrl: string, referer?: string): string {
  if (!rawUrl) return '';
  if (rawUrl.startsWith('/api/subtitle-proxy')) return rawUrl;
  let url = `/api/subtitle-proxy?url=${encodeURIComponent(rawUrl)}`;
  if (referer) url += `&referer=${encodeURIComponent(referer)}`;
  return url;
}

async function resolveModuleEpisodes(
  spec: AnimeSourceSpec,
  params: { anilistId?: string | number; title: string; altTitles?: string[] }
): Promise<any[]> {
  const numericAniListId = Number(params.anilistId);
  const cacheKey = `${spec.slug}:${Number.isFinite(numericAniListId) && numericAniListId > 0 ? numericAniListId : normalizeTitleText(params.title)}`;
  const cached = animeEpisodesCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < ANIME_EPISODES_CACHE_TTL && cached.episodes.length > 0) {
    return cached.episodes;
  }

  const mod = await withTimeout(getModuleRuntime(spec.slug), 6000, `${spec.slug}:init`);

  // Miruro and JustAnime accept AniList IDs natively for exact matching
  if ((spec.serverKey === 'miruro' || spec.serverKey === 'justanime') && Number.isFinite(numericAniListId) && numericAniListId > 0) {
    try {
      const directEps = await withTimeout<any[]>(
        mod.extractEpisodes(String(numericAniListId)),
        15_000,
        `${spec.slug}:episodes-direct`
      );
      if (Array.isArray(directEps) && directEps.length > 0) {
        animeEpisodesCache.set(cacheKey, { episodes: directEps, timestamp: Date.now() });
        return directEps;
      }
    } catch {
      // Fall through to title search if direct AniList ID lookup fails
    }
  }

  const { matchTargets, searchQueries } = buildSearchQueries(params.title, params.altTitles || []);
  let matchedItem: any = null;

  for (const q of searchQueries) {
    try {
      const res = await withTimeout<any>(mod.searchResults(q, 0), 12_000, `${spec.slug}:search`);
      const items = Array.isArray(res) ? res : Array.isArray(res?.items) ? res.items : [];
      const best = pickBestAnimeMatch(items, matchTargets);
      if (best) {
        matchedItem = best.item;
        break;
      }
    } catch {
      // Try next query variant
    }
  }

  if (!matchedItem) return [];

  const targetId = matchedItem.id || matchedItem.href;
  const eps = await withTimeout<any[]>(
    mod.extractEpisodes(targetId),
    18_000,
    `${spec.slug}:episodes`
  );
  const list = Array.isArray(eps) ? eps : [];
  if (list.length > 0) {
    animeEpisodesCache.set(cacheKey, { episodes: list, timestamp: Date.now() });
  }
  return list;
}

function normalizeMarkerRange(marker: any, startSec?: any, endSec?: any): { start: number; end: number } | undefined {
  const s = marker?.start ?? startSec;
  const e = marker?.end ?? endSec;
  if (typeof s === 'number' && typeof e === 'number' && Number.isFinite(s) && Number.isFinite(e) && e > s) {
    return { start: s, end: e };
  }
  return undefined;
}

function normalizeAnimeStreamPayload(spec: AnimeSourceSpec, rawRes: any) {
  if (!rawRes || rawRes.error) {
    return null;
  }

  const defaultHeaders = getDefaultHeadersForModule(spec.serverKey);
  const topHeaders = (rawRes.headers && typeof rawRes.headers === 'object' ? rawRes.headers : {}) as Record<string, string>;
  const collectedStreams: Array<{
    url: string;
    rawUrl: string;
    quality: string;
    isM3U8: boolean;
    server: string;
    serverId: string;
  }> = [];
  const seenUrls = new Set<string>();

  const pushStream = (rawUrl: any, qualityLabel?: string, itemHeaders?: any, serverLabel?: string) => {
    const cleanUrl = String(rawUrl || '').trim();
    if (!cleanUrl || !cleanUrl.startsWith('http') || seenUrls.has(cleanUrl)) return;
    seenUrls.add(cleanUrl);
    const mergedHdrs = { ...defaultHeaders, ...topHeaders, ...(itemHeaders || {}) };
    const referer = mergedHdrs.Referer || mergedHdrs.referer || defaultHeaders.Referer || '';
    const origin = mergedHdrs.Origin || mergedHdrs.origin || '';
    const isMp4 = /\.mp4(?:[?#&]|$)/i.test(cleanUrl);
    collectedStreams.push({
      url: buildHlsProxyUrl(cleanUrl, referer, origin),
      rawUrl: cleanUrl,
      quality: String(qualityLabel || rawRes.quality || 'Auto (HLS)'),
      isM3U8: !isMp4,
      server: serverLabel || spec.name,
      serverId: spec.serverKey,
    });
  };

  if (Array.isArray(rawRes.servers)) {
    for (const srv of rawRes.servers) {
      if (srv && typeof srv === 'object' && srv.url) {
        const rawQual = String(srv.quality || '').trim();
        const rawLabel = String(srv.label || '').trim();
        const validLabelQual = /\b(2160|1440|1080|720|540|480|360|240|144|4k)p?\b/i.test(rawLabel)
          ? rawLabel
          : '';
        pushStream(srv.url, rawQual || validLabelQual || 'Auto', srv.headers, srv.name || spec.name);
      }
    }
  }

  if (Array.isArray(rawRes.streams)) {
    if (rawRes.streams.length > 0 && typeof rawRes.streams[0] === 'string' && rawRes.streams.length % 2 === 0) {
      for (let i = 0; i < rawRes.streams.length; i += 2) {
        pushStream(rawRes.streams[i + 1], rawRes.streams[i]);
      }
    } else {
      for (const st of rawRes.streams) {
        if (st && typeof st === 'object') {
          pushStream(st.url || st.file, st.quality || st.label || 'Auto', st.headers);
        }
      }
    }
  }

  if (typeof rawRes.url === 'string') {
    pushStream(rawRes.url, rawRes.quality || 'Auto');
  }

  if (collectedStreams.length === 0) return null;

  const rawSubs: any[] = [];
  if (Array.isArray(rawRes.subtitles)) rawSubs.push(...rawRes.subtitles);
  if (Array.isArray(rawRes.servers)) {
    for (const srv of rawRes.servers) {
      if (Array.isArray(srv?.subtitles)) rawSubs.push(...srv.subtitles);
    }
  }

  const subtitles: Array<{ url: string; lang: string; label?: string; default?: boolean }> = [];
  const seenSubs = new Set<string>();
  const subReferer = topHeaders.Referer || topHeaders.referer || defaultHeaders.Referer || '';

  for (const sub of rawSubs) {
    const subRawUrl = String(sub?.url || sub?.file || '').trim();
    if (!subRawUrl || !subRawUrl.startsWith('http') || seenSubs.has(subRawUrl)) continue;
    const labelStr = String(sub?.label || sub?.lang || 'English').trim();
    if (/thumbnail|sprite|vtt-thumb/i.test(labelStr)) continue;
    seenSubs.add(subRawUrl);
    subtitles.push({
      url: buildSubtitleProxyUrl(subRawUrl, subReferer),
      lang: String(sub?.lang || labelStr),
      label: labelStr,
      default: Boolean(sub?.default) || labelStr.toLowerCase().includes('english'),
    });
  }

  let intro = normalizeMarkerRange(rawRes.intro, rawRes.introStartSeconds, rawRes.introEndSeconds);
  let outro = normalizeMarkerRange(rawRes.outro, rawRes.outroStartSeconds, rawRes.outroEndSeconds);
  if ((!intro || !outro) && Array.isArray(rawRes.servers)) {
    for (const srv of rawRes.servers) {
      if (!intro) intro = normalizeMarkerRange(srv?.intro, srv?.introStartSeconds, srv?.introEndSeconds);
      if (!outro) outro = normalizeMarkerRange(srv?.outro, srv?.outroStartSeconds, srv?.outroEndSeconds);
    }
  }

  return {
    server: spec.serverKey,
    sources: collectedStreams,
    subtitles,
    intro,
    outro,
  };
}

export async function fetchAnimeEpisodesList(params: {
  anilistId?: string | number;
  title: string;
  altTitles?: string[];
}) {
  // Follow strict Primary -> Fallback 1..4 order
  for (const spec of ANIME_SOURCE_MODULES) {
    try {
      const rawEps = await resolveModuleEpisodes(spec, params);
      if (!rawEps || rawEps.length === 0) continue;

      const episodes = rawEps
        .map((ep, idx) => {
          const epNum = Number(ep?.number ?? ep?.episode ?? idx + 1);
          if (!Number.isFinite(epNum) || epNum <= 0) return null;
          const rawTitle = String(ep?.title || '').trim();
          const cleanedTitle = rawTitle
            .replace(new RegExp(`^(?:S\\d+E${epNum}\\s*:\\s*)?(?:Episode\\s*${epNum}\\s*[:\\-–—]?\\s*)?`, 'i'), '')
            .trim();
          return {
            id: String(ep?.id || ep?.href || `${spec.serverKey}-ep-${epNum}`),
            number: epNum,
            title: cleanedTitle || `Episode ${epNum}`,
            description: ep?.description ? String(ep.description).trim() : undefined,
            image: ep?.image ? buildImageProxyUrl(String(ep.image), inferRefererForUrl(String(ep.image))) : undefined,
            isFiller: ep?.fillerStatus === 'filler' || Boolean(ep?.isFiller),
          };
        })
        .filter(Boolean);

      if (episodes.length > 0) {
        return {
          episodes,
          source: spec.serverKey,
          sourceName: spec.name,
        };
      }
    } catch {
      // Try next fallback source
    }
  }

  return { episodes: [], source: null, sourceName: null };
}

export async function resolveAnimeStreamHierarchy(params: {
  anilistId?: string | number;
  episodeNumber: number;
  title: string;
  altTitles?: string[];
  audioTrack?: 'sub' | 'dub';
  preferredServer?: AnimeServerKey;
  exactServerOnly?: boolean;
}) {
  const audioTrack = params.audioTrack === 'dub' ? 'dub' : 'sub';
  const startKey: AnimeServerKey =
    params.preferredServer && ANIME_SOURCE_MODULES.some((m) => m.serverKey === params.preferredServer)
      ? params.preferredServer
      : 'anikoto';

  const startIdx = ANIME_SOURCE_MODULES.findIndex((m) => m.serverKey === startKey);
  const orderedModules = params.exactServerOnly
    ? [ANIME_SOURCE_MODULES[startIdx]]
    : [
        ...ANIME_SOURCE_MODULES.slice(startIdx),
        ...ANIME_SOURCE_MODULES.slice(0, startIdx),
      ];

  const emptyServers: Record<AnimeServerKey, any> = {
    anikoto: { server: 'anikoto', sources: [], subtitles: [] },
    anikage: { server: 'anikage', sources: [], subtitles: [] },
    miruro: { server: 'miruro', sources: [], subtitles: [] },
    justanime: { server: 'justanime', sources: [], subtitles: [] },
    kickassanime: { server: 'kickassanime', sources: [], subtitles: [] },
  };

  let resolvedManifest: any = null;
  let activeServer: AnimeServerKey = startKey;

  for (const spec of orderedModules) {
    try {
      const episodes = await resolveModuleEpisodes(spec, {
        anilistId: params.anilistId,
        title: params.title,
        altTitles: params.altTitles,
      });
      if (!episodes || episodes.length === 0) continue;

      const targetEp =
        episodes.find((ep) => Number(ep?.number ?? ep?.episode) === Number(params.episodeNumber)) ||
        (episodes.length === 1 && params.episodeNumber === 1 ? episodes[0] : null);
      if (!targetEp) continue;

      const epRef = targetEp.href || targetEp.id || targetEp.url;
      if (!epRef) continue;

      const mod = await withTimeout(getModuleRuntime(spec.slug), 6000, `${spec.slug}:init`);
      const rawStream = await withTimeout<any>(
        mod.extractStreamUrl(epRef, audioTrack),
        28_000,
        `${spec.slug}:stream`
      );

      const normalized = normalizeAnimeStreamPayload(spec, rawStream);
      if (normalized && normalized.sources.length > 0) {
        emptyServers[spec.serverKey] = normalized;
        resolvedManifest = normalized;
        activeServer = spec.serverKey;
        break;
      }
    } catch {
      // Cascade cleanly to next fallback module
    }
  }

  if (!resolvedManifest) {
    return {
      success: false,
      servers: emptyServers,
      activeServer: startKey,
      sources: [],
      subtitles: [],
    };
  }

  return {
    success: true,
    servers: emptyServers,
    activeServer,
    sources: resolvedManifest.sources,
    subtitles: resolvedManifest.subtitles || [],
    intro: resolvedManifest.intro,
    outro: resolvedManifest.outro,
  };
}

function inferAnimeStreamReferer(rawUrl: string, explicitReferer?: string): string {
  let finalReferer = explicitReferer || '';
  if (!finalReferer || finalReferer.includes('megaplay.buzz')) {
    if (rawUrl.includes('animeheaven.me')) {
      finalReferer = 'https://animeheaven.me/';
    } else if (rawUrl.includes('animegg.org')) {
      finalReferer = 'https://www.animegg.org/';
    } else if (
      rawUrl.includes('nexabloom.top') ||
      rawUrl.includes('mysubsplay') ||
      rawUrl.includes('emeralddrift')
    ) {
      finalReferer = 'https://megaplay.buzz/';
    }
  }
  return finalReferer;
}

export async function handleHlsProxyRequest(req: any, res: any) {
  try {
    const rawUrl = String(req.query.url || '').trim();
    const referer = String(req.query.referer || '').trim();
    const explicitOrigin = String(req.query.origin || '').trim();
    if (!rawUrl || (!rawUrl.startsWith('http://') && !rawUrl.startsWith('https://'))) {
      return res.status(400).send('Invalid url parameter');
    }

    const headers: Record<string, string> = {
      'User-Agent': ANIME_UA,
      Accept: '*/*',
    };

    const finalReferer = inferAnimeStreamReferer(rawUrl, referer);
    if (finalReferer) {
      headers['Referer'] = finalReferer;
      try {
        headers['Origin'] = explicitOrigin || new URL(finalReferer).origin;
      } catch {}
    } else if (explicitOrigin) {
      headers['Origin'] = explicitOrigin;
    }

    if (req.headers.range) {
      headers['Range'] = String(req.headers.range);
    }

    const connectController = new AbortController();
    const connectTimeout = setTimeout(() => connectController.abort(), 20_000);
    let upstream: globalThis.Response;
    try {
      upstream = await fetch(rawUrl, {
        headers,
        signal: connectController.signal,
      });
    } finally {
      clearTimeout(connectTimeout);
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');

    const upstreamContentType = (upstream.headers.get('content-type') || '').toLowerCase();
    const isDeclaredM3U8 =
      rawUrl.includes('.m3u8') ||
      upstreamContentType.includes('mpegurl') ||
      upstreamContentType.includes('application/x-mpegurl');

    const rewriteM3U8 = (text: string) => {
      const refParam = finalReferer || referer;
      const lines = text.split('\n');
      return lines
        .map((line) => {
          const trimmed = line.trim();
          if (!trimmed) return line;
          if (trimmed.startsWith('#')) {
            if (trimmed.includes('URI="')) {
              return line.replace(/URI="([^"]+)"/g, (match, uriVal) => {
                try {
                  const abs = new URL(uriVal, rawUrl).href;
                  return `URI="${buildHlsProxyUrl(abs, refParam, explicitOrigin || undefined)}"`;
                } catch {
                  return match;
                }
              });
            }
            return line;
          }
          try {
            const abs = new URL(trimmed, rawUrl).href;
            return buildHlsProxyUrl(abs, refParam, explicitOrigin || undefined);
          } catch {
            return line;
          }
        })
        .join('\n');
    };

    res.status(upstream.status);

    if (isDeclaredM3U8) {
      const text = await upstream.text();
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-cache');
      return res.send(rewriteM3U8(text));
    }

    // Sniff disguised playlists (#EXTM3U served as image/jpeg, text/plain, octet-stream)
    // and disguised MPEG-TS (0x47 sync byte served as image/*)
    const shouldSniffPlaylist =
      upstream.ok &&
      upstream.body &&
      !upstreamContentType.startsWith('video/') &&
      !upstreamContentType.startsWith('audio/');

    if (shouldSniffPlaylist && upstream.body) {
      const reader = upstream.body.getReader();
      const firstRead = await reader.read();
      if (firstRead.done) {
        if (upstreamContentType) res.setHeader('Content-Type', upstreamContentType);
        return res.end();
      }
      const firstChunk = Buffer.from(firstRead.value);
      const headText = firstChunk.subarray(0, 64).toString('utf8').replace(/^\uFEFF/, '').trimStart();

      if (headText.startsWith('#EXTM3U')) {
        const chunks: Buffer[] = [firstChunk];
        while (true) {
          const nextRead = await reader.read();
          if (nextRead.done) break;
          chunks.push(Buffer.from(nextRead.value));
        }
        const fullText = Buffer.concat(chunks).toString('utf8');
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-cache');
        return res.send(rewriteM3U8(fullText));
      }

      const isTsPacket = firstChunk.length > 0 && firstChunk[0] === 0x47;
      if (isTsPacket && upstreamContentType.startsWith('image/')) {
        res.setHeader('Content-Type', 'video/mp2t');
      } else if (upstreamContentType) {
        res.setHeader('Content-Type', upstreamContentType);
      }

      if (upstream.ok) {
        res.setHeader('Cache-Control', 'public, max-age=3600');
      }
      const contentRange = upstream.headers.get('content-range');
      if (contentRange) res.setHeader('Content-Range', contentRange);
      const acceptRanges = upstream.headers.get('accept-ranges');
      if (acceptRanges) res.setHeader('Accept-Ranges', acceptRanges);
      const contentLength = upstream.headers.get('content-length');
      if (contentLength) res.setHeader('Content-Length', contentLength);

      let closed = false;
      res.on('close', () => {
        closed = true;
        reader.cancel().catch(() => {});
      });
      res.write(firstChunk);
      try {
        while (!closed) {
          const nextRead = await reader.read();
          if (nextRead.done) break;
          if (!res.write(Buffer.from(nextRead.value))) {
            await new Promise<void>((resolve) => res.once('drain', resolve));
          }
        }
      } catch {}
      return res.end();
    }

    if (upstreamContentType) res.setHeader('Content-Type', upstreamContentType);
    if (upstream.ok) {
      res.setHeader('Cache-Control', 'public, max-age=3600');
    }
    const contentRange = upstream.headers.get('content-range');
    if (contentRange) res.setHeader('Content-Range', contentRange);
    const acceptRanges = upstream.headers.get('accept-ranges');
    if (acceptRanges) res.setHeader('Accept-Ranges', acceptRanges);
    const contentLength = upstream.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    if (upstream.body) {
      const nodeStream = Readable.fromWeb(upstream.body as any);
      res.on('close', () => nodeStream.destroy());
      nodeStream.on('error', () => {
        if (!res.headersSent) res.status(502).end();
        else res.end();
      });
      return nodeStream.pipe(res);
    }

    const arrayBuffer = await upstream.arrayBuffer();
    return res.send(Buffer.from(arrayBuffer));
  } catch (err: any) {
    if (!res.headersSent) {
      return res.status(502).send(`HLS proxy error: ${err?.message || 'upstream error'}`);
    }
    return res.end();
  }
}

function convertSrtToVtt(rawText: string): string {
  const cleaned = rawText.replace(/^\uFEFF/, '').trim();
  if (/^WEBVTT/i.test(cleaned)) return cleaned;
  const converted = cleaned.replace(
    /(\d{1,2}:\d{2}:\d{2}),(\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}),(\d{3})/g,
    '$1.$2 --> $3.$4'
  );
  return `WEBVTT\n\n${converted}\n`;
}

export async function handleSubtitleProxyRequest(req: any, res: any) {
  try {
    const rawUrl = String(req.query.url || '').trim();
    const referer = String(req.query.referer || '').trim();
    if (!rawUrl || (!rawUrl.startsWith('http://') && !rawUrl.startsWith('https://'))) {
      return res.status(400).send('Invalid url parameter');
    }

    const headers: Record<string, string> = {
      'User-Agent': ANIME_UA,
      Accept: 'text/vtt, text/plain, */*',
    };
    const finalReferer = inferAnimeStreamReferer(rawUrl, referer);
    if (finalReferer) {
      headers['Referer'] = finalReferer;
      try {
        headers['Origin'] = new URL(finalReferer).origin;
      } catch {}
    }

    const upstream = await fetch(rawUrl, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });

    if (!upstream.ok) {
      return res.status(upstream.status).send(`Subtitle upstream HTTP ${upstream.status}`);
    }

    const rawText = await upstream.text();
    const vttText = convertSrtToVtt(rawText);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.send(vttText);
  } catch (err: any) {
    return res.status(502).send(`Subtitle proxy failed: ${err?.message || 'error'}`);
  }
}
