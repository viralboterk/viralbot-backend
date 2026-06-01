const axios = require('axios');
const { dbHelpers } = require('./database');
const logger = require('./logger');

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const BASE_URL = 'https://www.googleapis.com/youtube/v3';

// Category search queries
const CATEGORY_QUERIES = {
  movies: [
    'movie scene viral short', 'film clip incredible', 'cinema moment epic',
    'series scene reaction', 'movie trailer reaction', 'film best scene'
  ],
  stream: [
    'gaming clip viral', 'streamer funny moment', 'youtube gaming short',
    'youtuber reaction viral', 'gaming highlight short', 'twitch clip youtube'
  ],
  sports: [
    'sports highlight viral', 'football goal incredible', 'basketball dunk short',
    'athlete incredible moment', 'sports best moment', 'sport record viral'
  ],
  divert: [
    'funny viral short', 'entertainment viral video', 'comedy short viral',
    'challenge viral', 'animal funny viral', 'pov viral short'
  ],
  others: [
    'life hack viral short', 'incredible invention short', 'amazing skill viral',
    'unexpected viral moment', 'talent show viral', 'satisfying video short'
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
      relevanceLanguage: 'fr',
      safeSearch: 'strict',
    };
    if (publishedAfter) params.publishedAfter = publishedAfter;

    const res = await axios.get(`${BASE_URL}/search`, { params });
    const videoIds = res.data.items.map(item => item.id.videoId).filter(Boolean);
    return videoIds;
  } catch (err) {
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
  const words = text.toLowerCase().split(/\s+/);
  const frCount = words.filter(w => frWords.includes(w)).length;
  return frCount >= 2 ? 'FR' : 'EN';
}

// Filter videos by duration (60-90 seconds)
function filterByDuration(videos) {
  return videos.filter(v => v.duration >= 60 && v.duration <= 90);
}

// Copyright safety check (basic heuristics)
function copyrightSafetyCheck(video) {
  const riskyChannels = ['vevo', 'universal music', 'warner', 'sony music', 'umg', 'disney'];
  const channelLower = video.channelTitle.toLowerCase();
  if (riskyChannels.some(r => channelLower.includes(r))) return false;

  const riskyWords = ['official music video', 'official audio', 'full movie', 'full episode'];
  const titleLower = video.title.toLowerCase();
  if (riskyWords.some(r => titleLower.includes(r))) return false;

  return true;
}

// Main scan function for one category
async function scanCategory(category, type = 'both') {
  logger.info(`Scanning category: ${category} [${type}]`);
  const queries = CATEGORY_QUERIES[category] || CATEGORY_QUERIES.others;
  const results = { recent: [], evergreen: [] };

  // Recent videos (last 24h)
  if (type === 'both' || type === 'recent') {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    for (const query of queries.slice(0, 3)) {
      const ids = await searchShorts(query, 15, yesterday);
      const details = await getVideoDetails(ids);
      results.recent.push(...details);
      await sleep(300); // Rate limit protection
    }
  }

  // Evergreen videos (last 6 years, best performing)
  if (type === 'both' || type === 'evergreen') {
    const sixYearsAgo = new Date(Date.now() - 6 * 365 * 24 * 60 * 60 * 1000).toISOString();
    for (const query of queries.slice(3)) {
      const ids = await searchShorts(query, 15, sixYearsAgo);
      const details = await getVideoDetails(ids);
      results.evergreen.push(...details);
      await sleep(300);
    }
  }

  // Filter and sort
  const filterAndSort = (videos) => {
    return videos
      .filter(v => filterByDuration(v) && copyrightSafetyCheck(v))
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

  dbHelpers.logScan(category, totalFound, totalSelected, totalRejected);
  logger.info(`Category ${category}: ${totalSelected} selected (${recentFiltered.length} recent + ${evergreenFiltered.length} evergreen)`);

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
  dbHelpers.setStat('last_scan', new Date().toISOString());
  logger.info('Full scan complete');
  return results;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { scanCategory, scanAllCategories, getVideoDetails };
