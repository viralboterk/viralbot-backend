const axios = require('axios');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const logger = require('./logger');

// R2 Client
const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.R2_BUCKET_NAME || 'viral-videos';

// Get YouTube video direct download URL using yt-dlp API service
async function getYouTubeDirectUrl(videoId) {
  try {
    // Use cobalt.tools API - free, no key needed, returns direct mp4 URL
    const res = await axios.post('https://api.cobalt.tools/api/json', {
      url: `https://www.youtube.com/watch?v=${videoId}`,
      vQuality: '720',
      filenamePattern: 'basic',
      isAudioOnly: false,
    }, {
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });

    if (res.data && res.data.url) {
      logger.info(`Got direct URL for ${videoId} via cobalt.tools`);
      return res.data.url;
    }

    // Fallback: try y2mate API
    return await getYouTubeUrlFallback(videoId);

  } catch (err) {
    logger.error(`cobalt.tools error for ${videoId}: ${err.message}`);
    return await getYouTubeUrlFallback(videoId);
  }
}

// Fallback method using a different service
async function getYouTubeUrlFallback(videoId) {
  try {
    const res = await axios.get(`https://yt-api.p.rapidapi.com/dl?id=${videoId}`, {
      headers: {
        'X-RapidAPI-Key': process.env.RAPIDAPI_KEY || '',
        'X-RapidAPI-Host': 'yt-api.p.rapidapi.com',
      },
      timeout: 15000,
    });

    if (res.data && res.data.formats) {
      // Find best mp4 format between 360p and 720p
      const formats = res.data.formats.filter(f =>
        f.ext === 'mp4' &&
        f.height >= 360 &&
        f.height <= 720 &&
        f.url
      );
      if (formats.length > 0) {
        formats.sort((a, b) => b.height - a.height);
        logger.info(`Got direct URL for ${videoId} via fallback`);
        return formats[0].url;
      }
    }
    return null;
  } catch (err) {
    logger.error(`Fallback URL error for ${videoId}: ${err.message}`);
    return null;
  }
}

// Download video and upload to R2
async function downloadAndUploadToR2(videoId, category) {
  try {
    // Check if already in R2
    const r2Key = `videos/${category}/${videoId}.mp4`;
    const existingUrl = await getR2SignedUrl(r2Key);
    if (existingUrl) {
      logger.info(`Video ${videoId} already in R2`);
      return existingUrl;
    }

    // Get direct YouTube URL
    const directUrl = await getYouTubeDirectUrl(videoId);
    if (!directUrl) {
      logger.error(`Could not get direct URL for ${videoId}`);
      return null;
    }

    logger.info(`Downloading video ${videoId}...`);

    // Download video
    const response = await axios.get(directUrl, {
      responseType: 'arraybuffer',
      timeout: 120000, // 2 min timeout
      maxContentLength: 150 * 1024 * 1024, // 150MB max
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    const videoBuffer = Buffer.from(response.data);
    logger.info(`Downloaded ${videoId}: ${(videoBuffer.length / 1024 / 1024).toFixed(1)}MB`);

    // Upload to R2
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: r2Key,
      Body: videoBuffer,
      ContentType: 'video/mp4',
      Metadata: {
        videoId,
        category,
        uploadedAt: new Date().toISOString(),
      },
    }));

    logger.info(`Video ${videoId} uploaded to R2: ${r2Key}`);

    // Return signed URL valid for 24h
    const signedUrl = await getR2SignedUrl(r2Key);
    return signedUrl;

  } catch (err) {
    logger.error(`downloadAndUploadToR2 error for ${videoId}: ${err.message}`);
    return null;
  }
}

// Get signed URL from R2 (valid 24h)
async function getR2SignedUrl(key) {
  try {
    const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
    const url = await getSignedUrl(s3, command, { expiresIn: 86400 }); // 24h
    return url;
  } catch (err) {
    return null;
  }
}

// Delete from R2 after successful publish
async function deleteFromR2(key) {
  try {
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
    logger.info(`Deleted from R2: ${key}`);
  } catch (err) {
    logger.error(`R2 delete error: ${err.message}`);
  }
}

module.exports = { downloadAndUploadToR2, getYouTubeDirectUrl, deleteFromR2 };
