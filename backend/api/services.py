import requests
import datetime
import json
from pathlib import Path
from django.conf import settings

class MobilityService:
    def __init__(self):
        self.db = settings.DB_RATP
        # Use MongoDB collection when available, otherwise run in degraded mode.
        self.collection = self.db['station_stats'] if self.db is not None else None
        self.navitia_token = settings.NAVITIA_TOKEN
        self.allow_demo_fallback = getattr(settings, "NAVITIA_ALLOW_DEMO_FALLBACK", False)
        self.navitia_url = getattr(
            settings,
            "NAVITIA_JOURNEYS_URL",
            "https://prim.iledefrance-mobilites.fr/marketplace/v2/navitia/journeys",
        )
        # Ignore system proxy env vars that can break local calls with 403 tunnel errors.
        self.http = requests.Session()
        self.http.trust_env = False

    def _load_navitia_fallback(self):
        """Load local sample response when external Navitia API is unavailable."""
        fallback_path = Path(settings.BASE_DIR).parent / "response.json"
        if fallback_path.exists():
            with open(fallback_path, "r", encoding="utf-8") as f:
                return json.load(f)
        return None

    def _get_cat_jour(self, dt):
        """Détermine la catégorie de jour (JOHV, SAHV, DIJFP)"""
        weekday = dt.weekday()
        if weekday < 5:
            return 'JOHV' # Lundi à Vendredi
        elif weekday == 5:
            return 'SAHV' # Samedi
        else:
            return 'DIJFP' # Dimanche et Fériés

    def _get_time_slot(self, dt):
        """Formatage heure pour le dataset RATP (ex: '8H-9H')"""
        hour = dt.hour
        next_hour = (hour + 1) % 24
        return f"{hour}H-{next_hour}H"

    def _get_affluence_score(self, stop_area_id, dt):
        """
        Récupère le % de validation depuis MongoDB.
        Gère les IDs en format string ("473645") et int (473645).
        """
        if self.collection is None:
            return 0

        # Critères temporels
        cat_jour = self._get_cat_jour(dt)
        time_slot = self._get_time_slot(dt)
        
        # ID nettoyé (ex: "stop_area:IDFM:473645" -> "473645")
        clean_id_str = stop_area_id.split(':')[-1]
        
        # Logique de recherche
        base_query = {
            "cat_jour": cat_jour,
            "trnc_horr_60": time_slot
        }

        # 1. Essai ID texte
        query = base_query.copy()
        query["id_zdc"] = clean_id_str
        result = self.collection.find_one(query)

        # 2. Essai ID nombre (si échec)
        if not result:
            try:
                query["id_zdc"] = int(clean_id_str)
                result = self.collection.find_one(query)
            except ValueError:
                pass

        # 3. Extraction du résultat
        if result:
            val = result.get('pourcentage_validations', 0)
            # Si c'est du texte (ex: "12,5"), on convertit
            if isinstance(val, str):
                try:
                    val = float(val.replace(',', '.'))
                except:
                    val = 0
            return float(val)
            
        return 0

    @staticmethod
    def _navitia_error_message(exc: Exception) -> str:
        raw = str(exc)
        if any(
            marker in raw
            for marker in (
                "Failed to resolve",
                "NameResolutionError",
                "getaddrinfo failed",
                "nodename nor servname",
            )
        ):
            return (
                "echec DNS : impossible de resoudre prim.iledefrance-mobilites.fr. "
                "Verifie la connexion internet et le DNS (ex. ping ou nslookup sur ce domaine). "
                "Pour travailler sans reseau, mets NAVITIA_ALLOW_DEMO_FALLBACK=True dans backend/.env "
                "(itineraire de demo fige dans response.json)."
            )
        return raw

    def calculate_safe_route(self, depart_coord, arrivee_coord):
        # 1. Appel API PRIM / Navitia
        headers = {'apiKey': self.navitia_token}
        params = {
            'from': depart_coord,
            'to': arrivee_coord,
            'datetime': datetime.datetime.now().strftime('%Y%m%dT%H%M%S')
        }
        
        try:
            resp = self.http.get(self.navitia_url, headers=headers, params=params, timeout=20)
            resp.raise_for_status()
            data = resp.json()
        except Exception as e:
            # response.json est un echantillon fige (ex. Baconnets -> Ivry) : ne l'utiliser
            # que si la demo hors-ligne est explicitement autorisee.
            if self.allow_demo_fallback:
                data = self._load_navitia_fallback()
                if data is None:
                    return {"error": f"Erreur API: {self._navitia_error_message(e)}"}
            else:
                return {"error": f"Erreur API Navitia/PRIM: {self._navitia_error_message(e)}"}

        if 'journeys' not in data:
            return {"error": "Aucun itinéraire trouvé", "details": data}

        processed_journeys = []

        # 2. Traitement et Enrichissement IA
        for journey in data['journeys']:
            max_affluence = 0
            sections_data = []

            for section in journey['sections']:
                # On ne note que le transport public
                if section['type'] == 'public_transport':
                    try:
                        stop_id = section['from']['stop_point']['stop_area']['id']
                        dep_str = section['departure_date_time']
                        dep_dt = datetime.datetime.strptime(dep_str, '%Y%m%dT%H%M%S')
                        
                        # Appel MongoDB
                        score = self._get_affluence_score(stop_id, dep_dt)
                        
                        # Mise à jour du score max du trajet
                        if score > max_affluence:
                            max_affluence = score
                        
                        # Qualification (Vert/Orange/Rouge)
                        status = "Faible"
                        if score > 8: status = "Forte" # Rouge
                        elif score > 4: status = "Moyenne" # Orange

                        section['mobility_data'] = {
                            'affluence_score': score,
                            'status': status
                        }
                    except Exception as e:
                        # En cas d'erreur sur une section, on continue sans planter
                        print(f"Warning section: {e}")
                        section['mobility_data'] = {'status': 'Inconnu'}

                sections_data.append(section)

            # Résumé global du trajet
            journey['sections'] = sections_data
            if max_affluence == 0:
                # Fallback estimate when external crowd data is unavailable.
                # Spread components so similar journeys still get differentiable scores in the UI.
                duration_min = (journey.get('duration', 0) or 0) / 60
                transfers = journey.get('nb_transfers', 0) or 0
                pt_sections = sum(
                    1 for s in journey.get('sections', []) if s.get('type') == 'public_transport'
                )
                estimated = min(
                    10.0,
                    round(
                        2.0
                        + (transfers * 1.85)
                        + (duration_min / 22.0)
                        + (pt_sections * 0.45),
                        2,
                    ),
                )
                journey['global_crowd_score'] = estimated
                journey['score_source'] = 'estimated'
            else:
                journey['global_crowd_score'] = max_affluence
                journey['score_source'] = 'observed'
            # Seuil arbitraire : si score < 5, le trajet est "Safe" pour un phobique
            journey['is_safe_route'] = journey['global_crowd_score'] < 5 
            
            processed_journeys.append(journey)

        # 3. Tri intelligent : les trajets les moins stressants en premier
        processed_journeys.sort(key=lambda x: x['global_crowd_score'])

        return processed_journeys