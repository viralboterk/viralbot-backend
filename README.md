# ViralBot Backend — v1.0.0

Application de republication automatique YouTube Shorts → TikTok.

## Phase 1 — YouTube uniquement
- 5 catégories : Movies/Series, Streamer/Youtubeur, Sports, Divertissement, Others
- Top 48 par catégorie : 24 récentes (24h) + 24 evergreen (6 ans)
- Durée : 60s minimum — 90s maximum
- Diffusion : 1 vidéo toutes les 20 min de 06h00 à 22h00

## Variables d'environnement requises (.env)

YOUTUBE_API_KEY=ta_cle_youtube
TIKTOK_CLIENT_KEY=awh72kllzi120qke
TIKTOK_CLIENT_SECRET=ThsLiT0AdKALXVMBnro859w2tt3spWNT
R2_ACCOUNT_ID=475a325882823bfb045aba7d841836c5
R2_ACCESS_KEY_ID=98d7c806e4657df70ca17ebdb699fa95
R2_SECRET_ACCESS_KEY=beca24433026e5fb44f2b0b70c8430cd87912f3bb66f290e5eee0c0a286a8d27
R2_BUCKET_NAME=viral-videos
R2_ENDPOINT=https://475a325882823bfb045aba7d841836c5.r2.cloudflarestorage.com
ANTHROPIC_API_KEY=ta_cle_anthropic
APP_URL=https://ton-app.railway.app
PORT=3000

## Déploiement Railway

1. Push ce code sur GitHub
2. Connecte Railway à ton repo GitHub
3. Ajoute les variables d'environnement dans Railway
4. Deploy !

## API Endpoints

GET  /health              — Statut du serveur
GET  /api/stats           — Statistiques dashboard
GET  /api/accounts        — Liste des comptes
POST /api/accounts        — Ajouter un compte
PUT  /api/accounts/:handle/category — Assigner une catégorie
GET  /api/tiktok/connect/:handle    — URL OAuth TikTok
GET  /callback            — Callback OAuth TikTok
POST /api/scan            — Lancer un scan manuel
GET  /api/queue           — File d'attente
GET  /api/logs            — Logs de scan
GET  /api/system          — Infos système
