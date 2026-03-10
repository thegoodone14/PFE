import json
import time
import math
import hashlib
import requests
from django.conf import settings
from django.core.cache import cache

class PedestrianTomTomService:
    def __init__(self):
        self.key = settings.TOMTOM_KEY
        self.routing_url = "https://api.tomtom.com/routing/1/calculateRoute"
        self.search_url = "https://api.tomtom.com/search/2/search/{query}.json"
        self.traffic_url = "https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json"
        
        self.categories = [
            {"label": "monument", "q": "monument"},
            {"label": "attraction", "q": "tourist attraction"},
            {"label": "musée", "q": "museum"},
            {"label": "commercial", "q": "shopping mall"},
            {"label": "supermarché", "q": "supermarket"},
            {"label": "café", "q": "cafe"},
            {"label": "restaurant", "q": "restaurant"},
        ]
        
        self.points_limit = 6
        self.places_per_point = 3
        self.pause = 0.2

    def _generate_cache_key(self, prefix, params):
        s = json.dumps(params, sort_keys=True, ensure_ascii=False)
        hash_str = hashlib.sha256(s.encode()).hexdigest()
        return f"tomtom_{prefix}_{hash_str}"

    def safe_get(self, url, params=None, timeout=30, max_retries=3):
        delay = 1
        for i in range(max_retries):
            r = requests.get(url, params=params, timeout=timeout)
            if r.status_code == 429:
                time.sleep(delay)
                delay *= 2
                continue
            if r.status_code != 200:
                print(f"TomTom API Error: {r.text}")
            r.raise_for_status()
            return r
        return None

    def get_routes(self, start_lat, start_lng, end_lat, end_lng):
        coords = f"{start_lat},{start_lng}:{end_lat},{end_lng}"
        url = f"{self.routing_url}/{coords}/json"
        params = {
            "key": self.key,
            "travelMode": "pedestrian",
            "maxAlternatives": 2,
            "instructionsType": "text",
            "language": "fr-FR",
        }
        
        cache_key = self._generate_cache_key("route", {"coords": coords})
        cached_data = cache.get(cache_key)
        if cached_data: return cached_data

        r = self.safe_get(url, params)
        if r:
            data = r.json()
            cache.set(cache_key, data, timeout=7*24*3600) # Cache 7 jours
            return data
        return None

    def downsample(self, points, max_points=40):
        if len(points) <= max_points: return points
        step = len(points) / max_points
        out, i = [], 0.0
        while int(i) < len(points) and len(out) < max_points:
            out.append(points[int(i)])
            i += step
        if out[-1] != points[-1]: out.append(points[-1])
        return out

    def get_nearby_pois(self, lat, lng, query, limit=3):
        import urllib.parse
        encoded_query = urllib.parse.quote(query)
        url = f"https://api.tomtom.com/search/2/search/{encoded_query}.json"
        params = {"key": self.key, "lat": lat, "lon": lng, "radius": 300, "limit": limit}
        
        cache_key = self._generate_cache_key("search", {"lat": lat, "lon": lng, "q": query})
        cached = cache.get(cache_key)
        if cached: return cached

        r = self.safe_get(url, params)
        if r:
            data = r.json()
            cache.set(cache_key, data, timeout=24*3600) # Cache 24h
            return data
        return {"results": []}

    def get_traffic_score(self, lat, lng):
        params = {"key": self.key, "point": f"{lat},{lng}"}
        cache_key = self._generate_cache_key("traffic", {"lat": lat, "lon": lng})
        
        cached = cache.get(cache_key)
        if cached: return cached

        r = self.safe_get(self.traffic_url, params)
        if r:
            data = r.json()
            fd = data.get("flowSegmentData", {})
            current = fd.get("currentSpeed")
            freeflow = fd.get("freeFlowSpeed")
            
            if current and freeflow and freeflow > 0:
                ratio = current / freeflow
                score = max(0.0, min(100.0, (1 - ratio) * 100))
                score = round(score, 1)
                cache.set(cache_key, score, timeout=300) # Cache 5 mins (temps réel)
                return score
        return None

    def calculate_pedestrian_safe_routes(self, start_coord, end_coord):
        """
        Fonction principale appelée par la vue.
        Attend des formats "lon;lat" pour correspondre à votre logique Navitia.
        """
        try:
            # Conversion "lon;lat" -> lat, lon
            s_lng, s_lat = start_coord.split(';')
            e_lng, e_lat = end_coord.split(';')
        except:
            return {"error": "Format de coordonnées invalide. Utilisez 'lon;lat'"}

        routing_data = self.get_routes(s_lat, s_lng, e_lat, e_lng)
        if not routing_data or 'routes' not in routing_data:
            return {"error": "Aucun itinéraire piéton trouvé."}

        candidates = []
        for idx, route in enumerate(routing_data.get("routes", [])):
            # Extraction des points
            pts = []
            for leg in route.get("legs", []):
                for p in leg.get("points", []):
                    pts.append((p["latitude"], p["longitude"]))
            
            sampled_pts = self.downsample(pts, self.points_limit)
            heat_points = []

            # Analyse de l'affluence sur les points
            for (lat, lng) in sampled_pts:
                pt_scores = []
                for cat in self.categories:
                    near = self.get_nearby_pois(lat, lng, cat["q"], 1)
                    results = near.get("results", [])
                    if results:
                        poi = results[0]["position"]
                        score = self.get_traffic_score(poi["lat"], poi["lon"])
                        time.sleep(self.pause) # Anti rate-limit
                        if score is not None:
                            pt_scores.append(score)
                            break # Un seul POI valide suffit par point pour évaluer la zone
                
                if pt_scores:
                    avg = sum(pt_scores) / len(pt_scores)
                    heat_points.append({"lat": lat, "lng": lng, "busyness_score": round(avg, 1)})

            # Score global de la route (Moyenne)
            route_score = 0
            if heat_points:
                values = [h["busyness_score"] for h in heat_points]
                route_score = round(sum(values) / len(values), 2)

            # Résumé
            summary = route.get("summary", {})
            candidates.append({
                "type": "pedestrian",
                "route_index": idx + 1,
                "distance_m": summary.get("lengthInMeters", 0),
                "duration_min": round(summary.get("travelTimeInSeconds", 0) / 60, 1),
                "global_crowd_score": route_score,
                "is_safe_route": route_score < 40, # Critère arbitraire
                "heat_points": heat_points,
                "route_coordinates": pts # Pour tracer sur la carte Frontend
            })

        # Tri : le trajet le moins chargé en premier
        candidates.sort(key=lambda x: x["global_crowd_score"])
        return candidates