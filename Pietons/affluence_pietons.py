import os
import json
import time
import math
import hashlib
from datetime import datetime
from typing import Any, Dict, List, Tuple, Optional

import requests
import polyline

# ===========================
# CONFIG
# ===========================
BASE_URL = "https://serpapi.com/search.json"
# ⚠️ Attention : votre clé API est visible dans ce code. Pensez à la révoquer ou la cacher dans un fichier .env si vous publiez sur GitHub.
SERPAPI_KEY = "c59f42a764fae6554e14bece531e34c49f4e2aec14dadaba50151b3c2aaf9eb7"
RESET_CACHE_DIRECTIONS = False

CACHE_DIR = "cache_serpapi"
CACHE_DIRECTIONS_DIR = os.path.join(CACHE_DIR, "directions")
CACHE_PLACE_DIR = os.path.join(CACHE_DIR, "place")

DETAILS_PAUSE = 0.25
NEARBY_PAUSE = 0.15

POINTS_LIMIT_PROFILE = 3
PLACES_PER_POINT_PROFILE = 1
TOP_PINS = 20

ROUTE_METRIC = "mean"

CROWD_MIN_FOR_BUSY_LIST = 70

CATEGORIES = [
    {"label": "restaurant", "q": "restaurant"},
    {"label": "café", "q": "café"},
    {"label": "musée", "q": "musée"},
    {"label": "attraction touristique", "q": "attraction touristique"},
    {"label": "monument", "q": "monument"},
    {"label": "centre commercial", "q": "centre commercial"},
    {"label": "supermarché", "q": "supermarché"},
    {"label": "grand magasin", "q": "grand magasin"},
]

# ===========================
# CACHE & UTILITAIRES
# ===========================
def ensure_dirs():
    os.makedirs(CACHE_DIR, exist_ok=True)
    os.makedirs(CACHE_DIRECTIONS_DIR, exist_ok=True)
    os.makedirs(CACHE_PLACE_DIR, exist_ok=True)

def _hash_key(obj: Any) -> str:
    s = json.dumps(obj, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(s.encode("utf-8")).hexdigest()

def cache_get(path: str) -> Optional[Dict[str, Any]]:
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None

def cache_set(path: str, data: Dict[str, Any]) -> None:
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception:
        pass

def safe_get(url: str, params: Dict[str, Any], timeout: int = 60, max_retries: int = 6) -> Dict[str, Any]:
    backoff = 1
    for _ in range(max_retries):
        r = requests.get(url, params=params, timeout=timeout)
        if r.status_code == 200:
            return r.json()
        if r.status_code == 429:
            print(f"⚠️ 429 Too Many Requests -> pause {backoff}s")
            time.sleep(backoff)
            backoff *= 2
            continue
        r.raise_for_status()
    raise Exception("Trop de 429. Attends puis relance.")

def downsample_points(points: List[Tuple[float, float]], max_points: int):
    if len(points) <= max_points:
        return points
    step = len(points) / max_points
    out, i = [], 0.0
    while int(i) < len(points) and len(out) < max_points:
        out.append(points[int(i)])
        i += step
    if out[-1] != points[-1]:
        out.append(points[-1])
    return out

# ===========================
# GEOLOCALISATION & WAYPOINTS
# ===========================
def geocode_osm(address: str) -> Tuple[float, float]:
    """Convertit une adresse en coordonnées (lat, lng) gratuitement via Nominatim."""
    url = "https://nominatim.openstreetmap.org/search"
    params = {"q": address, "format": "json", "limit": 1}
    headers = {"User-Agent": "AffluencePietonsApp/1.0"} 
    
    r = requests.get(url, params=params, headers=headers)
    r.raise_for_status()
    data = r.json()
    if not data:
        raise ValueError(f"Adresse introuvable : {address}")
    return float(data[0]["lat"]), float(data[0]["lon"])

def generate_dynamic_waypoints(start_coords: Tuple[float, float], end_coords: Tuple[float, float], deviation: float = 0.25):
    """Génère 3 scénarios de route mathématiquement distincts."""
    lat1, lon1 = start_coords
    lat2, lon2 = end_coords

    # Point central
    mid_lat, mid_lon = (lat1 + lat2) / 2.0, (lon1 + lon2) / 2.0

    # Vecteur direct et correction de longitude
    dlat, dlon = lat2 - lat1, lon2 - lon1
    cos_lat = math.cos(math.radians(mid_lat))
    dx, dy = dlon * cos_lat, dlat

    # Vecteurs perpendiculaires
    perp_gauche_dx, perp_gauche_dy = -dy, dx
    perp_droite_dx, perp_droite_dy = dy, -dx

    # Points artificiels (Waypoints)
    wp_gauche_lat = mid_lat + (perp_gauche_dy * deviation)
    wp_gauche_lon = mid_lon + (perp_gauche_dx * deviation) / cos_lat
    wp_droite_lat = mid_lat + (perp_droite_dy * deviation)
    wp_droite_lon = mid_lon + (perp_droite_dx * deviation) / cos_lat

    return [
        {"name": "Route Directe", "via_coords": None},
        {"name": "Détour Gauche", "via_coords": (wp_gauche_lat, wp_gauche_lon)},
        {"name": "Détour Droite", "via_coords": (wp_droite_lat, wp_droite_lon)}
    ]

# ===========================
# PLACES + SCORE (SERPAPI)
# ===========================
def serpapi_nearby_places(lat: float, lng: float, query: str):
    params = {"engine": "google_maps", "q": query, "ll": f"@{lat},{lng},15z", "api_key": SERPAPI_KEY}
    return safe_get(BASE_URL, params)

def extract_places(maps_search_json: Dict[str, Any], max_places: int = 5):
    out = []
    if isinstance(maps_search_json.get("local_results"), list):
        for it in maps_search_json["local_results"]:
            gps = it.get("gps_coordinates") or {}
            out.append({
                "title": it.get("title"),
                "place_id": it.get("place_id"),
                "lat": gps.get("latitude"),
                "lng": gps.get("longitude"),
            })
    return out[:max_places]

def serpapi_place_details(place_id: str):
    params = {"engine": "google_maps", "type": "place", "place_id": place_id, "api_key": SERPAPI_KEY}
    return safe_get(BASE_URL, params)

def get_busyness_score(place_json: Dict[str, Any]):
    pr = place_json.get("place_results", {})
    rating = pr.get("rating")
    reviews = pr.get("reviews") or pr.get("reviews_count")
    open_state = pr.get("open_state", "")
    total, parts = 0, 0

    if isinstance(rating, (int, float)) and rating > 0:
        total += min(100, rating * 20)
        parts += 1
    if isinstance(reviews, int) and reviews > 0:
        total += min(100, math.log10(reviews + 1) * 40)
        parts += 1
    if isinstance(open_state, str) and "open" in open_state.lower():
        total += 60
        parts += 1

    return (total / parts) if parts else None

def route_heat_profile(route_points, categories):
    pts = downsample_points(route_points, POINTS_LIMIT_PROFILE)
    heat_points, used = [], 0

    for lat, lng in pts:
        scores = []
        for cat in categories:
            near = serpapi_nearby_places(lat, lng, cat["q"])
            time.sleep(NEARBY_PAUSE)
            places = extract_places(near, PLACES_PER_POINT_PROFILE)

            for p in places:
                details = serpapi_place_details(p["place_id"])
                time.sleep(DETAILS_PAUSE)
                s = get_busyness_score(details)
                if s is not None:
                    scores.append(s)

        if scores:
            used += 1
            heat_points.append({"lat": lat, "lng": lng, "busyness_score": sum(scores) / len(scores)})

    if not heat_points:
        return None, [], used

    route_score = sum(p["busyness_score"] for p in heat_points) / len(heat_points)
    return route_score, heat_points, used

# ===========================
# ANALYSE DES ROUTES
# ===========================
def analyze_pedestrian_routes(start: str, end: str, categories):
    print(f"\n=== ANALYSE DES ROUTES : {start} -> {end} ===")

    # 1. Géocodage
    try:
        start_coords = geocode_osm(start)
        end_coords = geocode_osm(end)
    except ValueError as e:
        print(f"⚠️ Erreur : {e}")
        return []

    # 2. Scénarios (Waypoints dynamiques)
    scenarios = generate_dynamic_waypoints(start_coords, end_coords, deviation=0.25)
    candidates = []

    # 3. Calcul via OSRM
    for idx, scenar in enumerate(scenarios, 1):
        print(f"\n--- Itinéraire {idx}: {scenar['name']} ---")
        
        start_str = f"{start_coords[1]},{start_coords[0]}"
        end_str = f"{end_coords[1]},{end_coords[0]}"
        
        if scenar["via_coords"]:
            via_lat, via_lon = scenar["via_coords"]
            coords_url = f"{start_str};{via_lon},{via_lat};{end_str}"
        else:
            coords_url = f"{start_str};{end_str}"

        url = f"http://router.project-osrm.org/route/v1/foot/{coords_url}"
        params = {"overview": "full", "geometries": "polyline"}
        
        try:
            r = requests.get(url, params=params)
            r.raise_for_status()
            data = r.json()
            
            routes = data.get("routes", [])
            if not routes:
                continue
            
            geometry = routes[0]["geometry"]
            full_pts = polyline.decode(geometry)
            route_pts = downsample_points(full_pts, 60) 
            
            # Calcul du score d'affluence
            score, heat_points, used = route_heat_profile(route_pts, categories)

            if score is not None:
                candidates.append({
                    "route_index": idx,
                    "route_name": scenar["name"],
                    "route_points": route_pts,
                    "route_score": score,
                    "used_points": used,
                    "heat_points": heat_points,
                })
                print(f"✅ Score calculé = {score:.2f} (sur {used} points de scan)")
            else:
                print("❌ Pas de score (manque de données SerpApi sur ce tracé)")

        except Exception as e:
            print(f"❌ Erreur réseau OSRM : {e}")

    # 4. Tri Croissant
    if not candidates:
        print("⚠️ Aucune route n'a pu être scorée.")
        return []

    candidates.sort(key=lambda x: x["route_score"])
    return candidates

# ===========================
# MAIN
# ===========================
def main():
    if not SERPAPI_KEY:
        print("SERPAPI_KEY manquant.")
        return

    ensure_dirs()

    start = "Place du Châtelet, Paris"
    end = "Eiffel Tower, Paris"

    routes_sorted = analyze_pedestrian_routes(start, end, CATEGORIES)

    print("\n=== CLASSEMENT DES ROUTES (calme -> bondée) ===")
    for r in routes_sorted:
        print(
            f"Route {r['route_index']} ({r['route_name']}) | "
            f"score={r['route_score']:.2f} | "
            f"points utilisés={r['used_points']}"
        )

    output = {
        "start": start,
        "end": end,
        "metric": ROUTE_METRIC,
        "routes_ranked": routes_sorted
    }

    with open("result.json", "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print("\n✅ result.json généré.")

if __name__ == "__main__":
    main()