# PFE

## Lancement rapide

### 1) Prerequis
- Python 3 installe
- Node.js + npm installes

### 2) Installation complete (une seule fois)
Depuis la racine du projet:

`npm run setup`

Cette commande:
- installe les dependances npm racine,
- cree `backend/.venv` + installe les dependances Python,
- installe les dependances frontend.

### 3) Commandes faciles
Depuis la racine du projet:

- Lancer backend uniquement: `npm run backend`
- Lancer frontend uniquement: `npm run frontend`
- Lancer les 2 en meme temps: `npm run dev`

## URLs utiles
- Frontend: `http://localhost:5173`
- Backend API: `http://127.0.0.1:8001/api/`

## Notes
- Le backend utilise automatiquement `backend/.venv`, pas besoin d'activer un venv manuellement.
- Pour le frontend, copie `frontend/.env.example` vers `frontend/.env` si ce n'est pas deja fait.
- Pour Mapbox, ajoute un token public dans `frontend/.env`:
  - `VITE_MAPBOX_TOKEN=...`
- Pour le backend, copie `backend/.env.example` vers `backend/.env` si ce n'est pas deja fait.
- Mets un `NAVITIA_TOKEN` valide dans `backend/.env` pour avoir des itineraires reels et varies.
- `NAVITIA_ALLOW_DEMO_FALLBACK=False` (par defaut) force les itineraires reels. Mets `True` seulement pour la demo hors ligne.
- Si tu veux seulement reinstaller le backend: `npm run setup:backend`
- Si tu veux seulement reinstaller le frontend: `npm run setup:frontend`
- Le backend demarre sur le port `8001` pour eviter le conflit classique sur `8000`.
- Pour identifier un process sur 8001: `lsof -nP -iTCP:8001 | rg LISTEN`