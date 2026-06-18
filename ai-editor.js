const Anthropic = require('@anthropic-ai/sdk');
const logger = require('./logger');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CATEGORY_CONTEXT = {
  movies: 'Films, séries, cinéma, scènes cultes',
  stream: 'Gaming, streamers, YouTubeurs, gaming highlights',
  sports: 'Sports, exploits sportifs, moments historiques',
  divert: 'Humour, divertissement, viral, animaux, challenges',
  others: 'Contenu viral inclassable, inventions, talents cachés',
};

async function callClaudeWithRetry(prompt, maxAttempts = 2) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }],
      });
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        logger.warn(`AI Editor call failed on attempt ${attempt} (${err.message}) — retrying in 2s`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }
  throw lastErr;
}

async function generateContent(video, category, language = 'auto') {
  try {
    const lang = language === 'auto' ? (video.lang || 'FR') : language.toUpperCase();
    const catContext = CATEGORY_CONTEXT[category] || 'Contenu viral';

    const prompt = `Tu es un expert en contenu viral TikTok spécialisé dans la catégorie "${catContext}".
Génère du contenu optimisé pour ce YouTube Short republié sur TikTok :

Titre original : "${video.title}"
Catégorie : ${catContext}
Vues YouTube : ${video.views?.toLocaleString() || 'N/A'}
Durée : ${video.duration}s
Langue cible : ${lang === 'FR' ? 'Français' : 'Anglais'}

IMPORTANT: Réponds UNIQUEMENT avec le JSON brut, SANS backticks, SANS markdown, SANS texte avant ou après. Commence directement par { et termine par } :
{
  "titre": "titre TikTok catchy max 80 chars",
  "description": "2-3 phrases : qui, où, quoi — ton accrocheur adapté à ${catContext}",
  "hashtags": ["tag1","tag2","tag3","tag4","tag5","tag6","tag7","tag8","tag9","tag10","tag11","tag12","tag13","tag14","tag15","tag16","tag17","tag18","tag19","tag20"],
  "hook": "accroche 2 premières secondes max 15 mots",
  "langue": "${lang}"
}`;

    const response = await callClaudeWithRetry(prompt);

    let text = response.content.map(c => c.text || '').join('').trim();
    // Strip markdown backticks if Claude adds them despite instructions
    text = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
    // Extract JSON object if there's surrounding text
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn('AI no JSON for ' + video.id + ': ' + text.substring(0, 80));
      return {
        titre: (video.title || 'Video viral').substring(0, 80),
        description: video.title || 'Contenu viral incroyable !',
        hashtags: ['viral', 'fyp', 'foryou', 'trending', 'shorts', category],
        hook: 'Tu vas pas croire ca...',
        langue: video.lang || 'FR',
      };
    }
    const json = JSON.parse(jsonMatch[0]);
    if (!json.titre) json.titre = (video.title || 'Video viral').substring(0, 80);
    if (!json.hashtags) json.hashtags = ['viral', 'fyp', 'foryou', 'trending', 'shorts', category];
    return json;
  } catch (err) {
    logger.error(`AI Editor error for ${video.id}: ${err.message}`);
    // Fallback content
    return {
      titre: video.title.substring(0, 80),
      description: video.description?.substring(0, 150) || 'Contenu viral incroyable !',
      hashtags: ['viral', 'fyp', 'foryou', 'trending', 'short', category],
      hook: 'Tu vas pas croire ce qui se passe ici...',
      langue: video.lang || 'FR',
    };
  }
}

module.exports = { generateContent };
