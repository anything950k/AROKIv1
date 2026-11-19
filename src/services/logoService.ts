const logoCache = new Map<string, string>();
const inFlightLogos = new Map<string, Promise<string | null>>();

export interface LogoFetchOptions {
  englishTitle?: string;
  romajiTitle?: string;
  category?: string;
  idMal?: number | string;
}

export async function fetchMediaLogo(
  title: string,
  options?: LogoFetchOptions
): Promise<string | null> {
  const primaryTitle = (title || options?.englishTitle || options?.romajiTitle || '').trim();
  if (!primaryTitle) return null;

  const cacheKey = (options?.englishTitle || primaryTitle).toLowerCase().trim();
  if (logoCache.has(cacheKey)) {
    return logoCache.get(cacheKey) ?? null;
  }

  const existing = inFlightLogos.get(cacheKey);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const params = new URLSearchParams();
      if (title) params.append('title', title.trim());
      if (options?.englishTitle) params.append('englishTitle', options.englishTitle.trim());
      if (options?.romajiTitle) params.append('romajiTitle', options.romajiTitle.trim());
      if (options?.category) params.append('category', options.category.trim());

      const res = await fetch(`/api/media/logo?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        if (data?.logoUrl) {
          logoCache.set(cacheKey, data.logoUrl);
          return data.logoUrl as string;
        }
      }
    } catch {
      // Return null so Hero Carousel displays normal text title
    } finally {
      inFlightLogos.delete(cacheKey);
    }
    return null;
  })();

  inFlightLogos.set(cacheKey, promise);
  return promise;
}
