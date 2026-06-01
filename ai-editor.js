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

Réponds UNIQUEMENT en JSON valide, sans markdown ni backticks :
{
  "titre": "titre TikTok catchy max 80 chars",
  "description": "2-3 phrases : qui, où, quoi — ton accrocheur adapté à ${catContext}",
  "hashtags": ["tag1","tag2","tag3","tag4","tag5","tag6","tag7","tag8","tag9","tag10","tag11","tag12","tag13","tag14","tag15","tag16","tag17","tag18","tag19","tag20"],
  "hook": "accroche 2 premières secondes max 15 mots",
  "langue": "${lang}"
}`;

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content.map(c => c.text || '').join('').trim();
    const json = JSON.parse(text);
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
