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
SERPAPI_KEY = os.getenv("SERPAPI_KEY", "").strip()

# Mets True UNE FOIS si tu veux forcer SerpApi à renvoyer les alternatives
# (ça supprime le cache directions au démarrage)
RESET_CACHE_DIRECTIONS = False

# Cache disque
CACHE_DIR = "cache_serpapi"
CACHE_DIRECTIONS_DIR = os.path.join(CACHE_DIR, "directions")
CACHE_PLACE_DIR = os.path.join(CACHE_DIR, "place")

# Anti 429 + ralentissement
DETAILS_PAUSE = 0.25
NEARBY_PAUSE = 0.15

# Limites (pour pas exploser ton quota)
POINTS_LIMIT_PROFILE = 7          # nb de points route analysés par itinéraire
PLACES_PER_POINT_PROFILE = 2      # nb de lieux analysés par point route
TOP_PINS = 20                     # liste des lieux "bondés" affichée

# Choix du score route : "mean" (moyenne) ou "max" (pire pic)
ROUTE_METRIC = "mean"  # "mean" ou "max"

# Filtrage des listes
CROWD_MIN_FOR_BUSY_LIST = 70      # au-dessus => "bondé"
CROWD_MAX_FOR_CALM_LIST = 40      # en-dessous => "calme" (souvent vide à Paris)

# Catégories (multi)
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
# UTILS CACHE
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


def clear_directions_cache():
    if os.path.isdir(CACHE_DIRECTIONS_DIR):
        for fn in os.listdir(CACHE_DIRECTIONS_DIR):
            if fn.lower().endswith(".json"):
                try:
                    os.remove(os.path.join(CACHE_DIRECTIONS_DIR, fn))
                except Exception:
                    pass


# ===========================
# SAFE GET (429 retry)
# ===========================
def safe_get(url: str, params: Dict[str, Any], timeout: int = 60, max_retries: int = 6) -> Dict[str, Any]:
    """
    Retry exponentiel sur 429.
    """
    backoff = 1
    for attempt in range(max_retries):
        r = requests.get(url, params=params, timeout=timeout)
        if r.status_code == 200:
            return r.json()

        if r.status_code == 429:
            print(f"⚠️ 429 Too Many Requests -> pause {backoff}s puis retry...")
            time.sleep(backoff)
            backoff *= 2
            continue

        # autres erreurs
        try:
            r.raise_for_status()
        except Exception as e:
            raise

    raise Exception("Trop de 429. Attends 2-5 minutes puis relance.")


# ===========================
# DIRECTIONS PEDESTRIAN (ALTERNATIVES)
# ===========================
def serpapi_directions_pedestrian(start: str, end: str, alternatives: bool = True, hl: str = "fr", gl: str = "fr") -> Dict[str, Any]:
    params = {
        "engine": "google_maps_directions",
        "start_addr": start,
        "end_addr": end,
        "travel_mode": 2,  # walking
        "hl": hl,
        "gl": gl,
        "api_key": SERPAPI_KEY,
    }
    if alternatives:
        # IMPORTANT: string "true"
        params["alternatives"] = "true"

    # cache directions (très important pour quota)
    key = _hash_key(params)
    cache_path = os.path.join(CACHE_DIRECTIONS_DIR, f"{key}.json")
    cached = cache_get(cache_path)
    if cached:
        print("✅ CACHE directions")
        return cached

    data = safe_get(BASE_URL, params)
    cache_set(cache_path, data)
    return data


def downsample_points(points: List[Tuple[float, float]], max_points: int) -> List[Tuple[float, float]]:
    if len(points) <= max_points:
        return points
    step = len(points) / max_points
    out, i = [], 0.0
    while int(i) < len(points) and len(out) < max_points:
        out.append(points[int(i)])
        i += step
    if out and out[-1] != points[-1]:
        out.append(points[-1])
    return out


def extract_route_points(directions_json: Dict[str, Any], max_points: int = 50) -> List[Tuple[float, float]]:
    # 1) polyline
    possible_keypaths = [
        ("routes", 0, "overview_polyline", "points"),
        ("overview_polyline", "points"),
        ("polyline",),
    ]
    for keypath in possible_keypaths:
        try:
            cur = directions_json
            for k in keypath:
                cur = cur[k]
            pts = polyline.decode(cur)
            return downsample_points(pts, max_points=max_points)
        except Exception:
            pass

    # 2) fallback gps_coordinates
    pts: List[Tuple[float, float]] = []

    def walk(obj: Any):
        if isinstance(obj, dict):
            if "gps_coordinates" in obj and isinstance(obj["gps_coordinates"], dict):
                lat = obj["gps_coordinates"].get("latitude")
                lng = obj["gps_coordinates"].get("longitude")
                if lat is not None and lng is not None:
                    pts.append((lat, lng))
            for v in obj.values():
                walk(v)
        elif isinstance(obj, list):
            for it in obj:
                walk(it)

    walk(directions_json)
    if not pts:
        raise ValueError("Aucun point trouvé dans la réponse Directions.")
    return downsample_points(pts, max_points=max_points)


def extract_routes_from_directions(directions_json: Dict[str, Any], max_points: int = 50) -> List[List[Tuple[float, float]]]:
    """
    Retourne liste de routes (chaque route = liste de points lat/lng).
    """
    routes = directions_json.get("routes", [])
    out = []
    if isinstance(routes, list) and routes:
        for r in routes:
            # tenter polyline par route
            try:
                p = r.get("overview_polyline", {}).get("points")
                if p:
                    pts = polyline.decode(p)
                    out.append(downsample_points(pts, max_points=max_points))
                    continue
            except Exception:
                pass

            # fallback: on essaye de parser route entière
            try:
                pts = extract_route_points({"routes": [r]}, max_points=max_points)
                out.append(pts)
            except Exception:
                pass

    # fallback si pas "routes"
    if not out:
        out.append(extract_route_points(directions_json, max_points=max_points))
    return out


# ===========================
# GOOGLE MAPS SEARCH NEARBY
# ===========================
def serpapi_nearby_places(lat: float, lng: float, query: str, zoom: int = 15, hl: str = "fr", gl: str = "fr") -> Dict[str, Any]:
    params = {
        "engine": "google_maps",
        "q": query,
        "ll": f"@{lat},{lng},{zoom}z",
        "hl": hl,
        "gl": gl,
        "api_key": SERPAPI_KEY,
    }
    return safe_get(BASE_URL, params)


def extract_places(maps_search_json: Dict[str, Any], max_places: int = 5) -> List[Dict[str, Any]]:
    out = []
    if isinstance(maps_search_json.get("local_results"), list):
        for it in maps_search_json["local_results"]:
            gps = it.get("gps_coordinates") or {}
            out.append({
                "title": it.get("title") or it.get("name"),
                "place_id": it.get("place_id"),
                "data_id": it.get("data_id"),
                "lat": gps.get("latitude"),
                "lng": gps.get("longitude"),
            })
    out = [p for p in out if (p.get("place_id") or p.get("data_id")) and p.get("lat") is not None and p.get("lng") is not None]
    return out[:max_places]


# ===========================
# PLACE DETAILS + CROWD
# ===========================
def serpapi_place_details(place_id: Optional[str] = None, data_id: Optional[str] = None, hl: str = "fr", gl: str = "fr") -> Dict[str, Any]:
    params = {
        "engine": "google_maps",
        "type": "place",
        "hl": hl,
        "gl": gl,
        "api_key": SERPAPI_KEY,
    }
    if place_id:
        params["place_id"] = place_id
    elif data_id:
        params["data_id"] = data_id
    else:
        return {}

    # cache place
    key = _hash_key(params)
    cache_path = os.path.join(CACHE_PLACE_DIR, f"{key}.json")
    cached = cache_get(cache_path)
    if cached:
        return cached

    data = safe_get(BASE_URL, params)
    cache_set(cache_path, data)
    return data


def get_busyness_score(place_json: Dict[str, Any], when_dt: Optional[datetime] = None) -> Tuple[Optional[float], str]:
    """
    Retourne (score, source):
      - score 0..100 (plus haut = plus bondé)
      - source: "live" / "graph" / "estimate"
    """
    if not place_json:
        return None, "none"
    if when_dt is None:
        when_dt = datetime.now()

    pr = (place_json or {}).get("place_results", {})
    popular = pr.get("popular_times")

    # 1) LIVE si dispo
    if isinstance(popular, dict):
        # certains retours ont "live_hash" + "graph_results"
        # mais le vrai score live est parfois dans les hours: live_busyness_score
        graph = popular.get("graph_results")
        if isinstance(graph, list):
            day_idx = when_dt.weekday()
            hour = when_dt.hour
            try:
                day_data = graph[day_idx]
                hours = day_data.get("hours") if isinstance(day_data, dict) else day_data
                if isinstance(hours, list):
                    for h in hours:
                        if h.get("hour") == hour:
                            if "live_busyness_score" in h:
                                return float(h["live_busyness_score"]), "live"
                            if "busyness_score" in h:
                                return float(h["busyness_score"]), "graph"
            except Exception:
                pass

    # 2) ESTIMATION (si pas de popular_times)
    rating = pr.get("rating")
    reviews = pr.get("reviews")
    open_state = pr.get("open_state", "")

    parts = 0
    total = 0.0

    if isinstance(rating, (int, float)) and rating > 0:
        total += max(0, min(100, float(rating) * 20))
        parts += 1

    if isinstance(reviews, int) and reviews > 0:
        total += min(100, math.log10(reviews + 1) * 40)
        parts += 1

    if isinstance(open_state, str) and "open" in open_state.lower():
        total += 60
        parts += 1

    if parts:
        return total / parts, "estimate"

    return None, "none"


# ===========================
# ROUTE SCORING (MULTI CATEGORIES)
# ===========================
def route_heat_profile(
    route_points: List[Tuple[float, float]],
    categories: List[Dict[str, str]],
    points_limit: int = POINTS_LIMIT_PROFILE,
    places_per_point: int = PLACES_PER_POINT_PROFILE,
) -> Tuple[Optional[float], List[Dict[str, Any]], int]:
    """
    Retourne:
      route_score (float) : plus haut = plus bondé
      heat_points: points route avec busyness_score
      used_points: nb points qui ont pu être scorés
    """
    pts = downsample_points(route_points, max_points=points_limit)

    used = 0
    heat_points = []

    # cache en mémoire pour éviter répétitions dans un run
    details_cache: Dict[str, Dict[str, Any]] = {}

    for (lat, lng) in pts:
        scores = []

        for cat in categories:
            q = cat["q"]
            near = serpapi_nearby_places(lat, lng, query=q)
            time.sleep(NEARBY_PAUSE)

            places = extract_places(near, max_places=places_per_point)
            for p in places:
                pid = p.get("place_id")
                did = p.get("data_id")
                key = pid or did
                if not key:
                    continue

                if key not in details_cache:
                    details_cache[key] = serpapi_place_details(place_id=pid, data_id=did)
                    time.sleep(DETAILS_PAUSE)

                s, _src = get_busyness_score(details_cache[key])
                if s is not None:
                    scores.append(float(s))

        if scores:
            used += 1
            heat_points.append({
                "lat": lat,
                "lng": lng,
                "busyness_score": sum(scores) / len(scores)
            })

    if not heat_points:
        return None, [], used

    if ROUTE_METRIC == "max":
        route_score = max(p["busyness_score"] for p in heat_points)
    else:
        route_score = sum(p["busyness_score"] for p in heat_points) / len(heat_points)

    return route_score, heat_points, used


def crowded_places_on_route(
    route_points: List[Tuple[float, float]],
    categories: List[Dict[str, str]],
    points_limit: int = POINTS_LIMIT_PROFILE,
    places_per_point: int = 2,
    crowd_min: float = CROWD_MIN_FOR_BUSY_LIST
) -> List[Dict[str, Any]]:
    pts = downsample_points(route_points, max_points=points_limit)

    details_cache: Dict[str, Dict[str, Any]] = {}
    found = []

    for (lat, lng) in pts:
        for cat in categories:
            near = serpapi_nearby_places(lat, lng, query=cat["q"])
            time.sleep(NEARBY_PAUSE)
            places = extract_places(near, max_places=places_per_point)

            for p in places:
                pid = p.get("place_id")
                did = p.get("data_id")
                key = pid or did
                if not key:
                    continue

                if key not in details_cache:
                    details_cache[key] = serpapi_place_details(place_id=pid, data_id=did)
                    time.sleep(DETAILS_PAUSE)

                s, src = get_busyness_score(details_cache[key])
                if s is None:
                    continue
                if s >= crowd_min:
                    found.append({
                        "category": cat["label"],
                        "title": p.get("title"),
                        "lat": p.get("lat"),
                        "lng": p.get("lng"),
                        "busyness_score": float(s),
                        "source": src,
                        "place_id": pid,
                    })

    # dédoublonnage
    uniq = {}
    for item in found:
        k = item.get("place_id") or (item["title"], item["lat"], item["lng"])
        if k not in uniq or item["busyness_score"] > uniq[k]["busyness_score"]:
            uniq[k] = item

    out = list(uniq.values())
    out.sort(key=lambda x: x["busyness_score"], reverse=True)
    return out


# ===========================
# CHOOSE CALMEST PEDESTRIAN ROUTE
# ===========================
def choose_calmest_pedestrian_route(
    start: str,
    end: str,
    categories: List[Dict[str, str]],
) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    print("=== 1) ITINERAIRE PIETON (alternatives si possible) ===")
    dj = serpapi_directions_pedestrian(start, end, alternatives=True)

    routes_pts = extract_routes_from_directions(dj, max_points=60)
    print("DEBUG nb routes dans JSON =", len(dj.get("routes", [])))
    print(f"✅ Nb routes candidates reçues: {len(routes_pts)}")

    candidates = []
    for idx, pts in enumerate(routes_pts, 1):
        score, heat_points, used = route_heat_profile(
            pts,
            categories=categories,
            points_limit=POINTS_LIMIT_PROFILE,
            places_per_point=PLACES_PER_POINT_PROFILE,
        )
        candidates.append({
            "route_index": idx,
            "route_points": pts,
            "route_score": score,
            "used_points": used,
            "heat_points": heat_points,
        })
        print(f"- Route {idx} -> route_score={score} (metric={ROUTE_METRIC}) used_points={used}")

    ok = [c for c in candidates if c["route_score"] is not None and c["used_points"] > 0]
    if not ok:
        raise Exception("Impossible de scorer les routes (pas assez de données / trop de 429 / quota).")

    # plus calme = score MIN
    best = min(ok, key=lambda x: x["route_score"])
    return best, candidates


# ===========================
# MAIN
# ===========================
def main():
    if not SERPAPI_KEY:
        print("❌ SERPAPI_KEY manquant.")
        print('➡️ PowerShell:  setx SERPAPI_KEY "TA_CLE"  puis REOUVRE PowerShell.')
        return

    ensure_dirs()

    if RESET_CACHE_DIRECTIONS:
        clear_directions_cache()
        print("🧹 Cache directions vidé (RESET_CACHE_DIRECTIONS=True)")

    # Mets exactement comme ton playground
    start = "Place du Châtelet, Paris"
    end = "Eiffel Tower, Paris"

    best, candidates = choose_calmest_pedestrian_route(start, end, categories=CATEGORIES)

    print("\n=== 2) SCORE SUR LA MEILLEURE ROUTE ===")
    print("✅ MEILLEUR ITINERAIRE")
    print("route =", best["route_index"])
    print(f"route_score = {best['route_score']:.4f} (metric={ROUTE_METRIC})")
    print("used_points =", best["used_points"])

    print("\n=== ROUTE (10 premiers points lat/lng) ===")
    for p in best["route_points"][:10]:
        print(p)

    print("\n=== Heat points (pour heatmap) ===")
    for hp in best["heat_points"][:5]:
        print(f"({hp['lat']},{hp['lng']}) busyness_score={hp['busyness_score']:.1f}")

    crowded = crowded_places_on_route(
        best["route_points"],
        categories=CATEGORIES,
        points_limit=POINTS_LIMIT_PROFILE,
        places_per_point=2,
        crowd_min=CROWD_MIN_FOR_BUSY_LIST
    )

    print("\n=== 3) LISTE DES LIEUX BONDÉS SUR LA ROUTE (pins) ===")
    if not crowded:
        print(f"Aucun lieu >= {CROWD_MIN_FOR_BUSY_LIST}.")
    else:
        for i, c in enumerate(crowded[:TOP_PINS], 1):
            print(f"{i}. [{c['category']}] {c['title']} | busyness_score={c['busyness_score']:.1f} ({c['source']}) | ({c['lat']},{c['lng']})")

    # export
    output = {
        "start": start,
        "end": end,
        "metric": ROUTE_METRIC,
        "best": {
            "route_index": best["route_index"],
            "route_score": best["route_score"],
            "used_points": best["used_points"],
            "route_points": best["route_points"],   # polyline -> points (pour tracer)
            "heat_points": best["heat_points"],     # heatmap
        },
        "candidates": [
            {
                "route_index": c["route_index"],
                "route_score": c["route_score"],
                "used_points": c["used_points"],
            } for c in candidates
        ],
        "crowded_places_top": crowded[:TOP_PINS],
    }

    with open("result.json", "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print("\n✅ Fichier result.json créé dans le même dossier.")


if __name__ == "__main__":
    main()