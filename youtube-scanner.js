const axios = require('axios');
const { dbHelpers } = require('./database');
const logger = require('./logger');

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const BASE_URL = 'https://www.googleapis.com/youtube/v3';

// Category search queries
const CATEGORY_QUERIES = {
  movies: [
    'movie scene viral shorts', 'film clip incredible moment', 'cinema epic scene shorts',
    'series best scene reaction', 'movie plot twist shorts', 'film emotional moment viral',
    'actor incredible performance short', 'blockbuster scene shorts viral'
  ],
  stream: [
    'gaming clip viral shorts', 'streamer funny moment shorts', 'gaming highlight viral',
    'youtuber reaction viral shorts', 'gamer insane play shorts', 'twitch clip viral shorts',
    'gaming world record shorts', 'streamer goes viral shorts'
  ],
  sports: [
    'sports highlight viral shorts', 'football goal incredible shorts', 'basketball dunk viral',
    'athlete incredible moment short', 'sports best moment shorts', 'sport world record viral',
    'soccer amazing goal shorts', 'nba highlight viral shorts', 'extreme sport viral shorts'
  ],
  divert: [
    'funny viral shorts', 'comedy shorts viral', 'pov viral shorts trending',
    'challenge viral shorts', 'animal funny viral shorts', 'satisfying video viral',
    'unexpected funny moment shorts', 'viral trend shorts foryou', 'fail compilation shorts'
  ],
  others: [
    'life hack viral shorts', 'incredible invention shorts', 'amazing skill viral shorts',
    'unexpected moment viral shorts', 'talent incredible shorts', 'satisfying shorts viral',
    'mind blowing shorts viral', 'genius idea viral shorts', 'viral shorts trending'
  ]
};

// Fetch YouTube Shorts by query
async function searchShorts(query, maxResults = 20, publishedAfter = null) {
  try {
    const params = {
      part: 'snippet',
      q: query + ' #shorts',
      type: 'video',
      videoDuration: 'short',
      maxResults,
      order: 'viewCount',
      key: YOUTUBE_API_KEY,
      // No language restriction — international content
      safeSearch: 'strict',
    };
    if (publishedAfter) params.publishedAfter = publishedAfter;

    const res = await axios.get(`${BASE_URL}/search`, { params });
    const videoIds = res.data.items.map(item => item.id.videoId).filter(Boolean);
    return videoIds;
  } catch (err) {
    const status = err.response && err.response.status;
    if (status === 429) {
      logger.error('YouTube API quota exceeded (429) — stopping scan');
      throw new Error('QUOTA_EXCEEDED');
    }
    logger.error(`YouTube search error [${query}]: ${err.message}`);
    return [];
  }
}

// Get video statistics and details
async function getVideoDetails(videoIds) {
  if (!videoIds.length) return [];
  try {
    const res = await axios.get(`${BASE_URL}/videos`, {
      params: {
        part: 'snippet,statistics,contentDetails',
        id: videoIds.join(','),
        key: YOUTUBE_API_KEY,
      }
    });

    return res.data.items.map(item => {
      const duration = parseDuration(item.contentDetails.duration);
      const stats = item.statistics;
      const views = parseInt(stats.viewCount || 0);
      const likes = parseInt(stats.likeCount || 0);
      const comments = parseInt(stats.commentCount || 0);

      // Score calculation
      const score = Math.round(
        (views * 2.0 + likes * 1.5 + comments * 1.0) / 1000000 * 10
      );

      return {
        id: item.id,
        title: item.snippet.title,
        description: item.snippet.description,
        thumbnail: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url,
        channelTitle: item.snippet.channelTitle,
        channelId: item.snippet.channelId,
        publishedAt: item.snippet.publishedAt,
        duration,
        views,
        likes,
        comments,
        score: Math.min(score, 100),
        lang: detectLanguage(item.snippet.title + ' ' + item.snippet.description),
        defaultAudioLanguage: item.snippet.defaultAudioLanguage || null,
        defaultLanguage: item.snippet.defaultLanguage || null,
      };
    });
  } catch (err) {
    logger.error(`YouTube details error: ${err.message}`);
    return [];
  }
}

// Parse ISO 8601 duration to seconds
function parseDuration(iso) {
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  return (parseInt(match[1] || 0) * 3600) + (parseInt(match[2] || 0) * 60) + parseInt(match[3] || 0);
}

// Language priority/exclusion filter — English absolute priority, then
// Arabic and French, then Asian (Chinese/Japanese/Korean/Thai/etc.); Hindi
// and any other language is excluded entirely. Combines three signals in
// order of reliability:
//  1. YouTube's own defaultAudioLanguage/defaultLanguage metadata, when
//     uploaders have set it — the most reliable signal for the actual
//     spoken language, but frequently left unset.
//  2. Script detection on the title — catches titles actually written in
//     Arabic, Devanagari, South Indian scripts, or CJK/Thai.
//  3. A keyword heuristic for Indian-cinema content: this category's
//     videos overwhelmingly have ENGLISH-LANGUAGE TITLES describing
//     Hindi/Telugu/Tamil audio content (e.g. "Pushpa's INSANE smuggling
//     plan", "Amitabh Bachchan Gets ANGRY at Rekha") — a pure script check
//     on the title alone would misclassify these as English, since only
//     the title is in English while the actual video audio is not.
// Returns 1 (English), 2 (Arabic/French), or 3 (Asian) to use as a ranking
// tier, or null to exclude the video entirely.
const INDIAN_CINEMA_MARKERS = [
  'bollywood', 'tollywood', 'kollywood', 'telugu', 'tamil nadu', 'tamil movie',
  'hindi movie', 'hindi serial', 'punjabi movie', 'malayalam movie', 'kannada movie',
  'bengali movie', 'bangla cinema', 'bengali cinema', 'marathi movie', 'desi drama',
  // Frequently-recurring actor/director names observed in this category's
  // scan results — a practical signal given titles are usually in English
  // even when the underlying audio is not.
  'venkatesh', 'mahesh babu', ' ntr ', 'amitabh bachchan', 'pushpa', 'rajamouli',
  'allu arjun', 'prabhas', 'rajinikanth', 'shah rukh khan', 'salman khan',
  'akshay kumar', 'ranveer singh', 'sundeep kishan', 'asrani', 'rekha',
  'abbayi garu', 'beeruva', 'raja saab', 'drishyam', 'kgf chapter', 'bahubali',
  'johny lever', 'ranbir kapoor', 'siyam ahmed', 'south indian movie', 'south indian cinema',
];

function detectLanguageTier(video) {
  const apiLang = (video.defaultAudioLanguage || video.defaultLanguage || '').toLowerCase();
  if (apiLang) {
    if (apiLang.startsWith('en')) return 1;
    if (apiLang.startsWith('ar') || apiLang.startsWith('fr')) return 2;
    if (['zh', 'ja', 'ko', 'th', 'vi', 'id', 'ms', 'tl'].some(l => apiLang.startsWith(l))) return 3;
    return null; // hi, ur, bn, ta, te, mr, pa, gu, kn, ml, and anything else not in the allow-list
  }

  const title = video.title || '';
  if (/[\u0900-\u097F]/.test(title)) return null; // Devanagari (Hindi/Marathi)
  if (/[\u0B80-\u0BFF\u0C00-\u0C7F\u0980-\u09FF\u0A80-\u0AFF\u0C80-\u0CFF\u0D00-\u0D7F\u0A00-\u0A7F]/.test(title)) return null; // Tamil/Telugu/Bengali/Gujarati/Kannada/Malayalam/Punjabi
  if (/[\u0600-\u06FF]/.test(title)) return 2; // Arabic script
  if (/[\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7A3\u0E00-\u0E7F]/.test(title)) return 3; // Chinese/Japanese/Korean/Thai

  // Latin-script title, no API language hint: catch English-titled Indian
  // cinema content via keyword markers before falling through to the
  // existing FR/ES/PT keyword check.
  const lowerTitle = title.toLowerCase();
  if (INDIAN_CINEMA_MARKERS.some(marker => lowerTitle.includes(marker))) return null;

  const lang = detectLanguage(title + ' ' + (video.description || ''));
  if (lang === 'FR') return 2;
  if (lang === 'ES' || lang === 'PT') return null; // not in the allow-list
  return 1; // default: English
}

// Simple language detection
function detectLanguage(text) {
  const frWords = ['le', 'la', 'les', 'de', 'du', 'des', 'un', 'une', 'et', 'est', 'en', 'que', 'qui', 'dans', 'pour', 'sur', 'avec', 'par'];
  const esWords = ['el', 'la', 'los', 'las', 'de', 'del', 'un', 'una', 'y', 'es', 'en', 'que', 'con', 'por', 'para'];
  const ptWords = ['o', 'a', 'os', 'as', 'de', 'do', 'da', 'um', 'uma', 'e', 'em', 'que', 'com', 'por', 'para'];
  const words = text.toLowerCase().split(/\s+/);
  const frCount = words.filter(w => frWords.includes(w)).length;
  const esCount = words.filter(w => esWords.includes(w)).length;
  const ptCount = words.filter(w => ptWords.includes(w)).length;
  if (frCount >= 3) return 'FR';
  if (esCount >= 3) return 'ES';
  if (ptCount >= 3) return 'PT';
  return 'EN'; // Default to English for international content
}

// Filter single video by duration (60-90 seconds)
function filterByDuration(video) {
  return video.duration >= 60 && video.duration <= 90;
}

// Copyright safety check (basic heuristics)
function copyrightSafetyCheck(video) {
  if (!video || !video.channelTitle || !video.title) return false;
  const riskyChannels = [
    'vevo', 'universal music', 'warner', 'sony music', 'umg', 'disney',
    'official music video', 'records', 'entertainment official',
    'columbia records', 'atlantic records', 'republic records'
  ];
  const channelLower = video.channelTitle.toLowerCase();
  if (riskyChannels.some(r => channelLower.includes(r))) return false;

  const riskyWords = ['official music video', 'official audio', 'full movie', 'full episode'];
  const titleLower = video.title.toLowerCase();
  if (riskyWords.some(r => titleLower.includes(r))) return false;

  return true;
}

// Real, persistent channel blacklist: any channel that fails the copyright
// heuristic once is recorded, and every future video from that channel is
// auto-rejected without needing to re-evaluate title/channel keywords.
async function passesContentFilters(video) {
  if (!filterByDuration(video)) return false;
  const blacklisted = await dbHelpers.isChannelBlacklisted(video.channelTitle);
  if (blacklisted) return false;
  if (!copyrightSafetyCheck(video)) {
    await dbHelpers.recordChannelRejection(video.channelTitle, 'copyright_heuristic');
    return false;
  }
  // Language priority filter: English (1) > Arabic/French (2) > Asian (3).
  // Hindi and any other language not in the allow-list (tier null) is
  // rejected outright, never selected regardless of score.
  if (detectLanguageTier(video) === null) return false;
  return true;
}
// Main scan function for one category — unified search, no recent/evergreen
// distinction. Previously: 3 queries restricted to "published in the last
// 24h" (often returned near-zero results — sports consistently hit 0) + 5-6
// queries restricted to "last 6 years". Now: ALL queries search across all
// time (publishedAfter omitted entirely), letting order=viewCount surface
// whatever performs best regardless of age, with no query budget wasted on
// an artificially narrow recency window.
async function scanCategory(category) {
  if (!YOUTUBE_API_KEY) {
    logger.error('YOUTUBE_API_KEY not set');
    return { all: [], quotaExceeded: false };
  }
  logger.info(`Scanning category: ${category} [unified, no age limit]`);
  const queries = CATEGORY_QUERIES[category] || CATEGORY_QUERIES.others;
  let allResults = [];
  let quotaExceeded = false;

  for (const query of queries) {
    try {
      const ids = await searchShorts(query, 50, null);
      const details = await getVideoDetails(ids);
      if (Array.isArray(details)) allResults.push(...details);
    } catch (e) {
      if (e.message === 'QUOTA_EXCEEDED') { quotaExceeded = true; break; }
      throw e;
    }
    await sleep(300); // Rate limit protection
  }

  // Filter and sort
  const filterAndSort = async (videos) => {
    if (!Array.isArray(videos)) return [];
    const candidates = videos.filter(Boolean);
    const checks = await Promise.all(candidates.map(v => passesContentFilters(v)));
    return candidates
      .filter((v, i) => checks[i])
      // Language priority first (1=English, 2=Arabic/French, 3=Asian — all
      // already passed the hard exclusion in passesContentFilters, this
      // just orders what's left so English fills the 48 slots before
      // lower-priority languages compete for the remaining room), score
      // as the tiebreaker within the same tier.
      .sort((a, b) => {
        const tierDiff = detectLanguageTier(a) - detectLanguageTier(b);
        if (tierDiff !== 0) return tierDiff;
        return b.score - a.score;
      })
      .reduce((acc, v) => { // Deduplicate
        if (!acc.find(x => x.id === v.id)) acc.push(v);
        return acc;
      }, []);
  };

  // 48 per category — the original target the .slice(0,24)+.slice(0,24)
  // caps were always aiming for, now reachable from one unified pool
  // instead of being split (and often starved) across two separate ones.
  const allFiltered = (await filterAndSort(allResults)).slice(0, 48);

  const totalFound = allResults.length;
  const totalSelected = allFiltered.length;
  const totalRejected = totalFound - totalSelected;

  await dbHelpers.logScan(category, totalFound, totalSelected, totalRejected);

  // Save scanned videos to DB for display in Top 48
  await dbHelpers.saveScannedVideos(category, allFiltered, 'all');

  logger.info('Category ' + category + ': ' + totalSelected + ' selected (recherche unifiée, sans distinction d\'âge)' +
    (quotaExceeded ? ' [quota exceeded mid-scan]' : ''));

  return { all: allFiltered, quotaExceeded };
}

// Scan all 5 categories
async function scanAllCategories() {
  logger.info('Starting full YouTube scan — all 5 categories');
  const results = {};
  const categories = ['movies', 'stream', 'sports', 'divert', 'others'];
  let quotaExceeded = false;
  for (const cat of categories) {
    results[cat] = await scanCategory(cat);
    if (results[cat].quotaExceeded) {
      quotaExceeded = true;
      logger.warn('Quota exceeded while scanning ' + cat + ' — stopping remaining categories for this run');
      break; // Google's quota is genuinely exhausted; trying the next categories would just waste more failed-call units
    }
    await sleep(1000);
  }
  // Metadata key, not a category — consumers must filter keys starting with
  // '_' before treating Object.values(results) as "one entry per category".
  results._quotaExceeded = quotaExceeded;
  await dbHelpers.setStat('last_scan', new Date().toISOString());
  logger.info('Full scan complete' + (quotaExceeded ? ' (quota exceeded mid-scan)' : ''));
  return results;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { scanCategory, scanAllCategories, getVideoDetails };
