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

// Main scan function for one category
async function scanCategory(category, type = 'both') {
  if (!YOUTUBE_API_KEY) {
    logger.error('YOUTUBE_API_KEY not set');
    return { recent: [], evergreen: [] };
  }
  logger.info(`Scanning category: ${category} [${type}]`);
  const queries = CATEGORY_QUERIES[category] || CATEGORY_QUERIES.others;
  const results = { recent: [], evergreen: [] };

  // Recent videos (last 24h)
  if (type === 'both' || type === 'recent') {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    for (const query of queries.slice(0, 3)) {
      const ids = await searchShorts(query, 15, yesterday);
      const details = await getVideoDetails(ids);
      if (Array.isArray(details)) results.recent.push(...details);
      await sleep(300); // Rate limit protection
    }
  }

  // Evergreen videos (last 6 years, best performing)
  if (type === 'both' || type === 'evergreen') {
    const sixYearsAgo = new Date(Date.now() - 6 * 365 * 24 * 60 * 60 * 1000).toISOString();
    for (const query of queries.slice(3)) {
      const ids = await searchShorts(query, 15, sixYearsAgo);
      const details = await getVideoDetails(ids);
      if (Array.isArray(details)) results.evergreen.push(...details);
      await sleep(300);
    }
  }

  // Filter and sort
  const filterAndSort = (videos) => {
    if (!Array.isArray(videos)) return [];
    return videos
      .filter(v => v && filterByDuration(v) && copyrightSafetyCheck(v))
      .sort((a, b) => b.score - a.score)
      .reduce((acc, v) => { // Deduplicate
        if (!acc.find(x => x.id === v.id)) acc.push(v);
        return acc;
      }, []);
  };

  const recentFiltered = filterAndSort(results.recent).slice(0, 24);
  const evergreenFiltered = filterAndSort(results.evergreen).slice(0, 24);

  const totalFound = results.recent.length + results.evergreen.length;
  const totalSelected = recentFiltered.length + evergreenFiltered.length;
  const totalRejected = totalFound - totalSelected;

  await dbHelpers.logScan(category, totalFound, totalSelected, totalRejected);
  
  // Save scanned videos to DB for display in Top 48
  await dbHelpers.saveScannedVideos(category, recentFiltered, 'recent');
  await dbHelpers.saveScannedVideos(category, evergreenFiltered, 'evergreen');
  
  logger.info('Category ' + category + ': ' + totalSelected + ' selected (' + recentFiltered.length + ' recent + ' + evergreenFiltered.length + ' evergreen)');

  return { recent: recentFiltered, evergreen: evergreenFiltered };
}

// Scan all 5 categories
async function scanAllCategories() {
  logger.info('Starting full YouTube scan — all 5 categories');
  const results = {};
  const categories = ['movies', 'stream', 'sports', 'divert', 'others'];
  for (const cat of categories) {
    results[cat] = await scanCategory(cat);
    await sleep(1000);
  }
  await dbHelpers.setStat('last_scan', new Date().toISOString());
  logger.info('Full scan complete');
  return results;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { scanCategory, scanAllCategories, getVideoDetails };
