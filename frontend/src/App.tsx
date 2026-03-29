import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import axios from 'axios'
import type { AxiosError } from 'axios'
import Map, { Layer, Marker, Source } from 'react-map-gl/mapbox'
import type { MapRef } from 'react-map-gl/mapbox'
import calmMoveLogo from './assets/calm-move-logo.svg'

type Mode = 'transport' | 'pedestrian'

type UiRoute = {
  id: string
  mode: Mode
  points: [number, number][]
  routeColor: string
  globalCrowdScore: number
  isSafeRoute: boolean
  title: string
  lineSummary?: string
  stationSummary?: string
  transferCount?: number
  durationMin?: number
  distanceM?: number
  crowdLabel?: 'calme' | 'modéré' | 'dense'
  crowdColor?: string
  directions?: string[]
  directionSteps?: Array<{
    mode: 'metro' | 'rer' | 'tram' | 'bus' | 'walk'
    line: string
    text: string
  }>
  heatPoints?: Array<{ lat: number; lng: number; busyness_score: number }>
}

type Coord = { lat: number; lng: number }
type AddressSuggestion = { label: string; shortLabel: string; lat: number; lng: number }

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:8001'
const API_FALLBACK_BASE_URLS = ['http://127.0.0.1:8001', 'http://localhost:8001', 'http://127.0.0.1:8000', 'http://localhost:8000']
const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN ?? ''
const ROUTE_COLORS = ['#1565C0', '#2E7D32', '#F57C00', '#8E24AA', '#D81B60']

function getCrowdStatus(score: number): { label: 'calme' | 'modéré' | 'dense'; color: string } {
  if (score < 4.3) return { label: 'calme', color: '#2e7d32' }
  if (score < 6.9) return { label: 'modéré', color: '#ef6c00' }
  return { label: 'dense', color: '#c62828' }
}

function crowdKeyFromLabel(label: UiRoute['crowdLabel']): 'calme' | 'modere' | 'dense' {
  if (label === 'modéré') return 'modere'
  if (label === 'dense') return 'dense'
  return 'calme'
}

/** When API scores are identical or almost flat (e.g. Mongo vide), rank options so labels differ. */
function applyRelativeCrowdLabelsIfNeeded(routes: UiRoute[]) {
  if (routes.length <= 1) return
  const scores = routes.map((r) => r.globalCrowdScore)
  const spread = Math.max(...scores) - Math.min(...scores)
  if (spread >= 2) return

  const sorted = [...routes].sort((a, b) => {
    if (a.globalCrowdScore !== b.globalCrowdScore) return a.globalCrowdScore - b.globalCrowdScore
    const tc = (a.transferCount ?? 0) - (b.transferCount ?? 0)
    if (tc !== 0) return tc
    return (a.durationMin ?? 0) - (b.durationMin ?? 0)
  })

  const n = sorted.length
  const labels: Array<'calme' | 'modéré' | 'dense'> =
    n === 2 ? ['calme', 'dense'] : ['calme', 'modéré', 'dense']

  sorted.forEach((r, i) => {
    const label = labels[Math.min(i, labels.length - 1)]
    const color = label === 'calme' ? '#2e7d32' : label === 'modéré' ? '#ef6c00' : '#c62828'
    r.crowdLabel = label
    r.crowdColor = color
  })
}

function inferTransportMode(section: any): 'metro' | 'rer' | 'tram' | 'bus' {
  const modeName = String(section?.display_informations?.commercial_mode ?? '').toLowerCase()
  if (modeName.includes('rer')) return 'rer'
  if (modeName.includes('tram')) return 'tram'
  if (modeName.includes('metro') || modeName.includes('métro')) return 'metro'
  return 'bus'
}

function formatLineForSummary(section: any): string {
  const mode = inferTransportMode(section)
  const raw = String(section?.display_informations?.label ?? section?.display_informations?.code ?? '').trim()
  if (!raw) return ''
  if (mode === 'rer') return raw.toLowerCase().startsWith('rer') ? raw.toUpperCase() : `RER ${raw.toUpperCase()}`
  if (mode === 'metro') return raw.toLowerCase().startsWith('m') ? raw.toUpperCase() : `M${raw}`
  if (mode === 'tram') return raw.toLowerCase().startsWith('t') ? raw.toUpperCase() : `T${raw}`
  return raw.toUpperCase()
}

function badgeText(mode: 'metro' | 'rer' | 'tram' | 'bus' | 'walk', line: string): string {
  const clean = line.trim()
  if (mode === 'walk') return 'PIETON'
  if (mode === 'metro') {
    if (clean.toLowerCase().startsWith('m')) return clean.toUpperCase()
    return `M${clean}`
  }
  if (mode === 'rer') {
    if (clean.toLowerCase().startsWith('rer')) return clean.toUpperCase()
    return `RER ${clean.toUpperCase()}`
  }
  return clean.toUpperCase()
}

function toLonLatString(coord: Coord): string {
  return `${coord.lng};${coord.lat}`
}

async function geocodeAddress(query: string): Promise<Coord> {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error('Erreur geocoding.')
  }
  const data = (await response.json()) as Array<{ lat: string; lon: string }>
  if (!data.length) {
    throw new Error(`Adresse introuvable: "${query}"`)
  }
  return { lat: Number(data[0].lat), lng: Number(data[0].lon) }
}

async function searchAddressSuggestions(query: string): Promise<AddressSuggestion[]> {
  const url =
    `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=6` +
    `&countrycodes=fr&bounded=1&viewbox=1.30,49.30,3.60,48.00&q=${encodeURIComponent(query)}`
  const response = await fetch(url)
  if (!response.ok) return []

  const data = (await response.json()) as Array<{
    display_name: string
    lat: string
    lon: string
    name?: string
    address?: {
      road?: string
      pedestrian?: string
      suburb?: string
      city_district?: string
      city?: string
      town?: string
      village?: string
    }
  }>
  return data.map((item) => ({
    label: item.display_name,
    shortLabel: [
      item.name || item.address?.road || item.address?.pedestrian || item.address?.suburb || 'Lieu',
      item.address?.city_district || item.address?.city || item.address?.town || item.address?.village || 'Ile-de-France',
    ].join(', '),
    lat: Number(item.lat),
    lng: Number(item.lon),
  }))
}

const FAVORITES_STORAGE_KEY = 'calm_move_favorite_places'

type FavoritePreset = 'home' | 'work' | 'other'

type FavoritePlace = {
  id: string
  preset: FavoritePreset
  name: string
  address: string
}

function safeParseFavorites(raw: string | null): FavoritePlace[] {
  if (!raw) return []
  try {
    const data = JSON.parse(raw) as unknown
    if (!Array.isArray(data)) return []
    const out: FavoritePlace[] = []
    for (const item of data) {
      if (!item || typeof item !== 'object') continue
      const o = item as Record<string, unknown>
      if (typeof o.id !== 'string' || typeof o.address !== 'string' || !o.address.trim()) continue
      const preset: FavoritePreset =
        o.preset === 'home' || o.preset === 'work' || o.preset === 'other' ? o.preset : 'other'
      const defaultName =
        preset === 'home' ? 'Maison' : preset === 'work' ? 'Travail' : 'Lieu'
      const name =
        typeof o.name === 'string' && o.name.trim() ? o.name.trim() : defaultName
      out.push({ id: o.id, preset, name, address: o.address.trim() })
    }
    return out
  } catch {
    return []
  }
}

function favoriteEmoji(preset: FavoritePreset): string {
  if (preset === 'home') return '\u{1F3E0}'
  if (preset === 'work') return '\u{1F4BC}'
  return '\u{1F4CC}'
}

type MapboxWalkingRoute = {
  points: [number, number][]
  durationMin: number
  distanceM: number
}

function uniqueRouteKey(points: [number, number][]): string {
  if (!points.length) return ''
  const picked = [points[0], points[Math.floor(points.length / 2)], points[points.length - 1]]
  return picked.map(([lng, lat]) => `${lng.toFixed(4)},${lat.toFixed(4)}`).join('|')
}

async function fetchSingleWalkingRoute(coords: string): Promise<MapboxWalkingRoute | null> {
  if (!MAPBOX_TOKEN) return null
  const url =
    `https://api.mapbox.com/directions/v5/mapbox/walking/${coords}` +
    `?geometries=geojson&overview=full&steps=false&access_token=${encodeURIComponent(MAPBOX_TOKEN)}`
  const response = await fetch(url)
  if (!response.ok) return null
  const data = (await response.json()) as {
    routes?: Array<{
      duration?: number
      distance?: number
      geometry?: { coordinates?: [number, number][] }
    }>
  }
  const first = data.routes?.[0]
  const points = Array.isArray(first?.geometry?.coordinates) ? first!.geometry!.coordinates! : []
  if (points.length < 2) return null
  return {
    points,
    durationMin: Number(((first?.duration ?? 0) / 60).toFixed(1)),
    distanceM: Number((first?.distance ?? 0).toFixed(0)),
  }
}

async function fetchMapboxWalkingRoutes(start: Coord, end: Coord): Promise<MapboxWalkingRoute[]> {
  if (!MAPBOX_TOKEN) {
    return [
      {
        points: [
          [start.lng, start.lat],
          [end.lng, end.lat],
        ],
        durationMin: 0,
        distanceM: 0,
      },
    ]
  }
  const coords = `${start.lng},${start.lat};${end.lng},${end.lat}`
  const url =
    `https://api.mapbox.com/directions/v5/mapbox/walking/${coords}` +
    `?alternatives=true&geometries=geojson&overview=full&steps=false&access_token=${encodeURIComponent(MAPBOX_TOKEN)}`

  const response = await fetch(url)
  if (!response.ok) {
    return [
      {
        points: [
          [start.lng, start.lat],
          [end.lng, end.lat],
        ],
        durationMin: 0,
        distanceM: 0,
      },
    ]
  }

  const data = (await response.json()) as {
    routes?: Array<{
      duration?: number
      distance?: number
      geometry?: { coordinates?: [number, number][] }
    }>
  }
  const routes = (data.routes ?? [])
    .map((route) => ({
      points: Array.isArray(route.geometry?.coordinates) ? route.geometry!.coordinates! : [],
      durationMin: Number(((route.duration ?? 0) / 60).toFixed(1)),
      distanceM: Number((route.distance ?? 0).toFixed(0)),
    }))
    .filter((route) => route.points.length >= 2)

  if (routes.length >= 2) return routes

  // If Mapbox returns too few alternatives, generate realistic detours via waypoints.
  const midLat = (start.lat + end.lat) / 2
  const midLng = (start.lng + end.lng) / 2
  const dLat = end.lat - start.lat
  const dLng = end.lng - start.lng
  const cosLat = Math.max(0.2, Math.cos((midLat * Math.PI) / 180))
  const pX = -dLat
  const pY = dLng * cosLat
  const n = Math.hypot(pX, pY) || 1
  const uX = pX / n
  const uY = pY / n
  const delta = 0.012 // ~1.3km-ish around Paris

  const viaA = { lng: midLng + (uY * delta) / cosLat, lat: midLat + uX * delta }
  const viaB = { lng: midLng - (uY * delta) / cosLat, lat: midLat - uX * delta }

  const [detourA, detourB] = await Promise.all([
    fetchSingleWalkingRoute(`${start.lng},${start.lat};${viaA.lng},${viaA.lat};${end.lng},${end.lat}`),
    fetchSingleWalkingRoute(`${start.lng},${start.lat};${viaB.lng},${viaB.lat};${end.lng},${end.lat}`),
  ])

  const merged = [...routes]
  if (detourA) merged.push(detourA)
  if (detourB) merged.push(detourB)

  const unique: MapboxWalkingRoute[] = []
  const seen = new Set<string>()
  for (const route of merged) {
    const key = uniqueRouteKey(route.points)
    if (key && !seen.has(key)) {
      seen.add(key)
      unique.push(route)
    }
  }

  if (unique.length) return unique

  return [
    {
      points: [
        [start.lng, start.lat],
        [end.lng, end.lat],
      ],
      durationMin: 0,
      distanceM: 0,
    },
  ]
}

function extractTransportPoints(journey: any, fallback: [Coord, Coord]): [number, number][] {
  const out: [number, number][] = []
  for (const section of journey.sections ?? []) {
    const sectionCoords = section?.geojson?.coordinates
    if (Array.isArray(sectionCoords) && sectionCoords.length) {
      for (const point of sectionCoords) {
        if (Array.isArray(point) && point.length >= 2) {
          const [lng, lat] = point
          out.push([lng, lat])
        }
      }
    }
  }

  if (out.length >= 2) return out
  return [
    [fallback[0].lng, fallback[0].lat],
    [fallback[1].lng, fallback[1].lat],
  ]
}

function mapTransportResponse(data: any, start: Coord, end: Coord): UiRoute[] {
  if (!Array.isArray(data)) return []
  const routes = data.map((journey, index) => {
    const ptSections = Array.isArray(journey.sections)
      ? journey.sections.filter((s: any) => s?.type === 'public_transport')
      : []
    const lines = ptSections
      .map((s: any) => formatLineForSummary(s))
      .filter((value: unknown): value is string => typeof value === 'string' && value.trim().length > 0)
    const uniqueLines = Array.from(new Set(lines))
    const firstStation = ptSections[0]?.from?.name
    const lastStation = ptSections[ptSections.length - 1]?.to?.name
    const transferCount = Number(journey.nb_transfers ?? 0)
    const fullLineSummary = uniqueLines.join(' • ')
    const crowd = getCrowdStatus(Number(journey.global_crowd_score ?? 0))
    const directions = ptSections.map((section: any) => {
      const line = section?.display_informations?.label ?? section?.display_informations?.code ?? 'ligne'
      const from = section?.from?.name ?? 'depart'
      const to = section?.to?.name ?? 'arrivee'
      return `Prendre ${line} de ${from} a ${to}`
    })
    const directionSteps = ptSections.map((section: any) => {
      const line = String(section?.display_informations?.label ?? section?.display_informations?.code ?? 'Ligne')
      const from = section?.from?.name ?? 'depart'
      const to = section?.to?.name ?? 'arrivee'
      return {
        mode: inferTransportMode(section),
        line,
        text: `Prendre ${line} de ${from} a ${to}`,
      }
    })

    return {
      id: `transport-${index + 1}`,
      mode: 'transport' as const,
      points: extractTransportPoints(journey, [start, end]),
      routeColor: ROUTE_COLORS[index % ROUTE_COLORS.length],
      globalCrowdScore: Number(journey.global_crowd_score ?? 0),
      isSafeRoute: Boolean(journey.is_safe_route),
      title: `Itineraire transport ${index + 1}`,
      lineSummary: fullLineSummary || undefined,
      stationSummary: firstStation && lastStation ? `${firstStation} -> ${lastStation}` : undefined,
      transferCount,
      durationMin: Number(((journey.duration ?? 0) / 60).toFixed(1)),
      crowdLabel: crowd.label,
      crowdColor: crowd.color,
      directions,
      directionSteps,
    }
  })

  // Suggest simple routes first: fewer transfers, then shorter duration.
  routes.sort((a, b) => {
    const transferDiff = (a.transferCount ?? 99) - (b.transferCount ?? 99)
    if (transferDiff !== 0) return transferDiff
    return (a.durationMin ?? 999) - (b.durationMin ?? 999)
  })

  // Remove duplicate itineraries so each card is meaningfully different.
  const uniqueRoutes: UiRoute[] = []
  const seen = new Set<string>()
  for (const route of routes) {
    const signature = [
      route.stationSummary ?? '',
      route.lineSummary ?? '',
      route.transferCount ?? 0,
      route.durationMin ?? 0,
      route.points.slice(0, 3).map((p) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`).join('|'),
    ].join('::')
    if (!seen.has(signature)) {
      seen.add(signature)
      uniqueRoutes.push(route)
    }
  }

  // Remove weak routes that do not provide meaningful transit details.
  const meaningfulRoutes = uniqueRoutes.filter(
    (route) =>
      Boolean(route.lineSummary && route.lineSummary.trim().length > 0) ||
      Boolean(route.stationSummary && route.stationSummary.trim().length > 0),
  )

  // Keep UI focused on simple unique choices.
  const top = meaningfulRoutes.slice(0, 3).map((route, index) => ({
    ...route,
    title: index === 0 ? 'Recommande (le plus simple)' : `Itineraire ${index + 1}`,
  }))
  applyRelativeCrowdLabelsIfNeeded(top)
  return top
}

function mapPedestrianResponse(data: any): UiRoute[] {
  if (!Array.isArray(data)) return []
  return data.map((route, index) => {
    const points = Array.isArray(route.route_coordinates)
      ? route.route_coordinates
          .filter((p: any) => Array.isArray(p) && p.length >= 2)
          .map((p: any) => [Number(p[1]), Number(p[0])] as [number, number])
      : []

    const crowd = getCrowdStatus(Number(route.global_crowd_score ?? 0))
    const directions = [
      'Suivre le trace sur la carte.',
      route.duration_min ? `Temps estime: ${route.duration_min} min.` : 'Temps estime indisponible.',
      route.distance_m ? `Distance: ${route.distance_m} m.` : 'Distance indisponible.',
    ]

    return {
      id: `pedestrian-${index + 1}`,
      mode: 'pedestrian' as const,
      points,
      routeColor: ROUTE_COLORS[index % ROUTE_COLORS.length],
      globalCrowdScore: Number(route.global_crowd_score ?? 0),
      isSafeRoute: Boolean(route.is_safe_route),
      title: `Itineraire pieton ${index + 1}`,
      durationMin: Number(route.duration_min ?? 0),
      distanceM: Number(route.distance_m ?? 0),
      crowdLabel: crowd.label,
      crowdColor: crowd.color,
      directions,
      directionSteps: directions.map((text) => ({ mode: 'walk' as const, line: 'PIETON', text })),
      heatPoints: route.heat_points ?? [],
    }
  })
}

async function enrichPedestrianRoutesWithRealGeometry(
  routes: UiRoute[],
  start: Coord,
  end: Coord,
): Promise<UiRoute[]> {
  // Always try to offer multiple realistic walking alternatives.
  const altRoutes = await fetchMapboxWalkingRoutes(start, end)
  if (!altRoutes.length) return routes

  // Plus long = souvent plus detourne : on le classe comme le plus "calme" cote score affiche.
  const ranked = [...altRoutes].sort((a, b) => (b.distanceM || 0) - (a.distanceM || 0))

  return ranked.slice(0, 3).map((alt, index) => {
    const score = 3.1 + index * 2.85
    const crowd = getCrowdStatus(score)
    return {
      id: `pedestrian-mapbox-${index + 1}`,
      mode: 'pedestrian',
      title:
        index === 0
          ? 'Recommande (pieton plus calme)'
          : index === 1
            ? 'Itineraire equilibre'
            : 'Itineraire plus direct',
      points: alt.points,
      routeColor: ROUTE_COLORS[index % ROUTE_COLORS.length],
      globalCrowdScore: score,
      isSafeRoute: crowd.label === 'calme',
      durationMin: alt.durationMin,
      distanceM: alt.distanceM,
      crowdLabel: crowd.label,
      crowdColor: crowd.color,
      directions: [
        'Suivre le trace pieton detaille sur la carte.',
        alt.durationMin ? `Temps estime: ${alt.durationMin} min.` : 'Temps estime indisponible.',
        alt.distanceM ? `Distance: ${alt.distanceM} m.` : 'Distance indisponible.',
      ],
      directionSteps: [
        {
          mode: 'walk',
          line: 'PIETON',
          text: `Itineraire ${crowd.label} — suivre le trace sur la carte.`,
        },
      ],
      heatPoints: [],
    }
  })
}

function getApiErrorFromPayload(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null
  const payload = data as { error?: unknown; details?: unknown }
  if (typeof payload.error === 'string' && payload.error.trim()) return payload.error
  if (typeof payload.details === 'string' && payload.details.trim()) return payload.details
  return null
}

function getFriendlyNetworkError(err: unknown): string {
  if (!axios.isAxiosError(err)) {
    return err instanceof Error ? err.message : 'Requete impossible.'
  }

  const axiosErr = err as AxiosError<{ error?: string; details?: string }>
  if (axiosErr.response) {
    const payload = axiosErr.response.data
    const backendMessage = payload?.error ?? payload?.details
    return backendMessage ? String(backendMessage) : `Erreur backend (${axiosErr.response.status}).`
  }

  return "Impossible de joindre l'API backend. Verifie que `npm run backend` tourne."
}

function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(() => localStorage.getItem('calm_move_auth') === '1')
  const [loginEmail, setLoginEmail] = useState('')
  const [loginPassword, setLoginPassword] = useState('')
  const [loginError, setLoginError] = useState('')
  const [mode, setMode] = useState<Mode>('transport')
  const [startInput, setStartInput] = useState('Place du Chatelet, Paris')
  const [endInput, setEndInput] = useState('Tour Eiffel, Paris')
  const [routes, setRoutes] = useState<UiRoute[]>([])
  const [selectedRouteId, setSelectedRouteId] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showRoutePopup, setShowRoutePopup] = useState(false)
  const [userLocation, setUserLocation] = useState<{ lng: number; lat: number; heading: number | null } | null>(null)
  const mapRef = useRef<MapRef | null>(null)
  const watchIdRef = useRef<number | null>(null)
  const [activeField, setActiveField] = useState<'start' | 'end' | null>(null)
  const [startSuggestions, setStartSuggestions] = useState<AddressSuggestion[]>([])
  const [endSuggestions, setEndSuggestions] = useState<AddressSuggestion[]>([])
  const [favorites, setFavorites] = useState<FavoritePlace[]>(() =>
    safeParseFavorites(
      typeof localStorage !== 'undefined' ? localStorage.getItem(FAVORITES_STORAGE_KEY) : null,
    ),
  )
  const [favoritePreset, setFavoritePreset] = useState<FavoritePreset>('home')
  const [favoriteNameInput, setFavoriteNameInput] = useState('')
  const [favoriteAddressInput, setFavoriteAddressInput] = useState('')
  const [favoriteFormOpen, setFavoriteFormOpen] = useState(false)

  useEffect(() => {
    localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(favorites))
  }, [favorites])

  const selectedRoute = useMemo(
    () => routes.find((r) => r.id === selectedRouteId) ?? routes[0],
    [routes, selectedRouteId],
  )

  const center = selectedRoute?.points?.[0] ?? [2.3522, 48.8566]

  function handleLogin(event: FormEvent) {
    event.preventDefault()
    if (!loginEmail.trim() || !loginPassword.trim()) {
      setLoginError('Email et mot de passe requis.')
      return
    }
    localStorage.setItem('calm_move_auth', '1')
    setIsLoggedIn(true)
    setLoginError('')
  }

  function handleLogout() {
    localStorage.removeItem('calm_move_auth')
    setIsLoggedIn(false)
  }

  function swapStartEnd() {
    const prevStart = startInput
    setStartInput(endInput)
    setEndInput(prevStart)
  }

  function addFavoritePlace() {
    const address = favoriteAddressInput.trim()
    if (!address) return
    const defaultName =
      favoritePreset === 'home' ? 'Maison' : favoritePreset === 'work' ? 'Travail' : 'Lieu'
    const name = favoriteNameInput.trim() || defaultName
    const id =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `fav-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    setFavorites((prev) => [...prev, { id, preset: favoritePreset, name, address }])
    setFavoriteAddressInput('')
    setFavoriteNameInput('')
    setFavoriteFormOpen(false)
  }

  function removeFavoritePlace(id: string) {
    setFavorites((prev) => prev.filter((p) => p.id !== id))
  }

  function applyFavoriteTo(field: 'start' | 'end', place: FavoritePlace) {
    if (field === 'start') setStartInput(place.address)
    else setEndInput(place.address)
  }

  function zoomToRoute(route: UiRoute | undefined) {
    if (!route || !route.points.length || !mapRef.current) return
    let minLng = route.points[0][0]
    let maxLng = route.points[0][0]
    let minLat = route.points[0][1]
    let maxLat = route.points[0][1]

    for (const [lng, lat] of route.points) {
      if (lng < minLng) minLng = lng
      if (lng > maxLng) maxLng = lng
      if (lat < minLat) minLat = lat
      if (lat > maxLat) maxLat = lat
    }

    mapRef.current.fitBounds(
      [
        [minLng, minLat],
        [maxLng, maxLat],
      ],
      { padding: 18, duration: 900, maxZoom: 17.2 },
    )
  }

  function requestUserLocation() {
    if (!navigator.geolocation) return

    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current)
      watchIdRef.current = null
    }

    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const next = {
          lng: pos.coords.longitude,
          lat: pos.coords.latitude,
          heading: Number.isFinite(pos.coords.heading as number) ? (pos.coords.heading as number) : null,
        }
        setUserLocation(next)
        if (mapRef.current) {
          mapRef.current.flyTo({ center: [next.lng, next.lat], zoom: 15, duration: 700 })
        }
      },
      () => {},
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 1500 },
    )
  }

  useEffect(() => {
    return () => {
      if (watchIdRef.current !== null && navigator.geolocation) {
        navigator.geolocation.clearWatch(watchIdRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (selectedRoute) {
      zoomToRoute(selectedRoute)
    }
  }, [selectedRouteId])

  useEffect(() => {
    const value = activeField === 'start' ? startInput : activeField === 'end' ? endInput : ''
    if (!activeField || value.trim().length < 1) {
      if (activeField === 'start') setStartSuggestions([])
      if (activeField === 'end') setEndSuggestions([])
      return
    }

    const timeout = setTimeout(async () => {
      const suggestions = await searchAddressSuggestions(value)
      if (activeField === 'start') setStartSuggestions(suggestions)
      if (activeField === 'end') setEndSuggestions(suggestions)
    }, 250)

    return () => clearTimeout(timeout)
  }, [startInput, endInput, activeField])

  async function resolveInput(input: string): Promise<Coord> {
    return geocodeAddress(input)
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setLoading(true)
    setError('')

    try {
      const [startCoord, endCoord] = await Promise.all([resolveInput(startInput), resolveInput(endInput)])
      const payload = {
        start: toLonLatString(startCoord),
        end: toLonLatString(endCoord),
      }
      const endpoint = mode === 'transport' ? '/api/search/' : '/api/pedestrian/'
      const candidateBaseUrls = [API_BASE_URL, ...API_FALLBACK_BASE_URLS].filter(
        (value, index, arr) => arr.indexOf(value) === index,
      )

      let responseData: any = null
      let lastError: unknown = null
      for (const baseUrl of candidateBaseUrls) {
        try {
          const { data } = await axios.post(`${baseUrl}${endpoint}`, payload, { timeout: 12000 })
          const apiError = getApiErrorFromPayload(data)
          if (apiError) {
            throw new Error(apiError)
          }
          responseData = data
          break
        } catch (err) {
          lastError = err
          if (axios.isAxiosError(err) && err.response) {
            throw err
          }
        }
      }

      if (responseData === null && lastError) {
        throw lastError
      }
      const nextRoutes =
        mode === 'transport'
          ? mapTransportResponse(responseData, startCoord, endCoord)
          : mapPedestrianResponse(responseData)

      const finalRoutes =
        mode === 'pedestrian'
          ? await enrichPedestrianRoutesWithRealGeometry(nextRoutes, startCoord, endCoord)
          : nextRoutes

      if (!finalRoutes.length) {
        setError("Aucun itineraire renvoye par l'API.")
      }
      setRoutes(finalRoutes)
      setSelectedRouteId(finalRoutes[0]?.id ?? '')
    } catch (err) {
      setRoutes([])
      setSelectedRouteId('')
      setError(`Erreur: ${getFriendlyNetworkError(err)}`)
    } finally {
      setLoading(false)
    }
  }

  const homeFavorite = favorites.find((f) => f.preset === 'home')
  const workFavorite = favorites.find((f) => f.preset === 'work')

  if (!isLoggedIn) {
    return (
      <main className="login-page">
        <section className="login-card">
          <img src={calmMoveLogo} alt="Calm Move" className="brand-logo-login" />
          <h1>Connexion</h1>
          <p>Connecte-toi a Calm Move pour trouver un itineraire plus serein en Ile-de-France.</p>
          <form onSubmit={handleLogin} className="search-form">
            <label>
              Email
              <input
                type="email"
                value={loginEmail}
                onChange={(e) => setLoginEmail(e.target.value)}
                placeholder="utilisateur@email.com"
              />
            </label>
            <label>
              Mot de passe
              <input
                type="password"
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
                placeholder="********"
              />
            </label>
            <button type="submit">Se connecter</button>
          </form>
          {loginError ? <p className="error">{loginError}</p> : null}
        </section>
      </main>
    )
  }

  return (
    <main className="app-shell">
      <aside className="panel">
        <div className="panel-topbar">
          <div className="panel-brand">
            <span className="burger-icon">☰</span>
            <img src={calmMoveLogo} alt="Calm Move" className="brand-logo-header" />
          </div>
          <button type="button" className="logout-btn" onClick={handleLogout}>
            Deconnexion
          </button>
        </div>
        <p className="subtitle">Itinéraires en Île-de-France, avec une lecture simple de l&apos;affluence.</p>

        <section className="trust-card">
          <div className="trust-card-inner">
            <span className="trust-icon" aria-hidden>
              ◉
            </span>
            <div>
              <div className="trust-chip">Zones calmes</div>
              <p className="trust-text">Priorité aux trajets les plus sereins selon les données disponibles.</p>
            </div>
          </div>
        </section>

        <section className="search-card">
          <form onSubmit={handleSubmit} className="search-form">
            <div className="planner-row">
              <div className="planner-meta">
                <span className="planner-eyebrow">Horaire</span>
                <span className="planner-now">
                  <span className="planner-live-dot" aria-hidden />
                  Partir maintenant
                </span>
              </div>
            </div>

            <div className="favorites-block">
              <div className="favorites-header">
                <span className="favorites-title">Lieux favoris</span>
                <button
                  type="button"
                  className="linkish-btn"
                  onClick={() => setFavoriteFormOpen((open) => !open)}
                >
                  {favoriteFormOpen ? 'Fermer' : '+ Ajouter'}
                </button>
              </div>
              {favoriteFormOpen ? (
                <div className="favorite-form">
                  <label className="favorite-form-row">
                    Type
                    <select
                      value={favoritePreset}
                      onChange={(e) => setFavoritePreset(e.target.value as FavoritePreset)}
                    >
                      <option value="home">Maison</option>
                      <option value="work">Travail</option>
                      <option value="other">Autre</option>
                    </select>
                  </label>
                  <label className="favorite-form-row">
                    Nom (optionnel)
                    <input
                      value={favoriteNameInput}
                      onChange={(e) => setFavoriteNameInput(e.target.value)}
                      placeholder="Ex: Salle de sport"
                    />
                  </label>
                  <label className="favorite-form-row">
                    Adresse
                    <input
                      value={favoriteAddressInput}
                      onChange={(e) => setFavoriteAddressInput(e.target.value)}
                      placeholder="Adresse complete, Ile-de-France"
                    />
                  </label>
                  <button type="button" className="favorite-save-btn" onClick={addFavoritePlace}>
                    Enregistrer le lieu
                  </button>
                </div>
              ) : null}
              {favorites.length > 0 ? (
                <ul className="favorites-list">
                  {favorites.map((place) => (
                    <li key={place.id} className="favorites-list-item">
                      <span className="fav-line">
                        <span className="fav-emoji" aria-hidden>
                          {favoriteEmoji(place.preset)}
                        </span>
                        <span className="fav-name">{place.name}</span>
                      </span>
                      <span className="fav-actions">
                        <button
                          type="button"
                          className="fav-pill"
                          onClick={() => applyFavoriteTo('start', place)}
                        >
                          Depart
                        </button>
                        <button
                          type="button"
                          className="fav-pill"
                          onClick={() => applyFavoriteTo('end', place)}
                        >
                          Arrivee
                        </button>
                        <button
                          type="button"
                          className="fav-remove"
                          aria-label={`Retirer ${place.name}`}
                          onClick={() => removeFavoritePlace(place.id)}
                        >
                          ×
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="favorites-hint">
                  Enregistre Maison, Travail ou d&apos;autres lieux pour remplir départ ou arrivée en un geste.
                </p>
              )}
              {homeFavorite && workFavorite ? (
                <button
                  type="button"
                  className="quick-commute-btn"
                  onClick={() => {
                    setStartInput(homeFavorite.address)
                    setEndInput(workFavorite.address)
                  }}
                >
                  Raccourci Maison → Travail
                </button>
              ) : null}
            </div>

            <div className="trip-planner-fields">
              <div className="trip-rail" aria-hidden="true">
                <span className="trip-dot trip-dot-from" />
                <span className="trip-rail-connector" />
                <span className="trip-dot trip-dot-to" />
              </div>
              <div className="trip-fields-col">
                <label className="trip-field">
                  <span className="trip-field-label">Départ</span>
                  <div className="autocomplete trip-input-wrap">
                    <input
                      value={startInput}
                      onFocus={() => setActiveField('start')}
                      onBlur={() => setTimeout(() => setActiveField(null), 150)}
                      onChange={(e) => setStartInput(e.target.value)}
                      placeholder="Adresse, lieu ou arrêt"
                    />
                    {activeField === 'start' && startSuggestions.length > 0 ? (
                      <ul className="suggestions-list">
                        {startSuggestions.map((item) => (
                          <li key={`${item.lat}-${item.lng}-${item.label}`}>
                            <button
                              type="button"
                              onMouseDown={() => {
                                setStartInput(item.shortLabel)
                                setStartSuggestions([])
                              }}
                            >
                              {item.shortLabel}
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                </label>
                <div className="trip-swap-row">
                  <button
                    type="button"
                    className="trip-swap-btn"
                    onClick={swapStartEnd}
                    aria-label="Inverser le départ et l'arrivée"
                  >
                    <span className="trip-swap-icon" aria-hidden>
                      ⇅
                    </span>
                    Inverser
                  </button>
                </div>
                <label className="trip-field">
                  <span className="trip-field-label">Arrivée</span>
                  <div className="autocomplete trip-input-wrap">
                    <input
                      value={endInput}
                      onFocus={() => setActiveField('end')}
                      onBlur={() => setTimeout(() => setActiveField(null), 150)}
                      onChange={(e) => setEndInput(e.target.value)}
                      placeholder="Adresse, lieu ou arrêt"
                    />
                    {activeField === 'end' && endSuggestions.length > 0 ? (
                      <ul className="suggestions-list">
                        {endSuggestions.map((item) => (
                          <li key={`${item.lat}-${item.lng}-${item.label}`}>
                            <button
                              type="button"
                              onMouseDown={() => {
                                setEndInput(item.shortLabel)
                                setEndSuggestions([])
                              }}
                            >
                              {item.shortLabel}
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                </label>
              </div>
            </div>
            <div className="mode-toolbar" role="group" aria-label="Mode de déplacement">
              <span className="mode-toolbar-label">Mode</span>
              <div className="mode-toggle">
                <button
                  type="button"
                  className={`mode-btn ${mode === 'transport' ? 'active' : ''}`}
                  onClick={() => setMode('transport')}
                >
                  <span className="mode-icon" aria-hidden="true">
                    🚇
                  </span>
                  <span>Transports</span>
                </button>
                <button
                  type="button"
                  className={`mode-btn ${mode === 'pedestrian' ? 'active' : ''}`}
                  onClick={() => setMode('pedestrian')}
                >
                  <span className="mode-icon" aria-hidden="true">
                    🚶
                  </span>
                  <span>À pied</span>
                </button>
              </div>
            </div>
            <button type="submit" className="journey-submit-btn" disabled={loading}>
              {loading ? 'Calcul des trajets…' : 'Voir les itinéraires'}
            </button>
          </form>
        </section>

        {error && <p className="error">{error}</p>}

        <section className="route-list">
          <div className="route-list-header">
            <h2>Itinéraires</h2>
            <span className="route-list-count">
              {routes.length} {routes.length > 1 ? 'options' : 'option'}
            </span>
          </div>
          {routes.length === 0 && (
            <div className="empty-card">
              <strong>Aucun trajet affiché</strong>
              <p>Indique un départ et une arrivée, puis lance la recherche pour comparer les parcours.</p>
            </div>
          )}
          {routes.map((route) => {
            const active = route.id === selectedRoute?.id
            const crowdK = crowdKeyFromLabel(route.crowdLabel)
            const dur =
              route.durationMin != null && route.durationMin > 0
                ? Math.max(1, Math.round(route.durationMin))
                : null
            return (
              <button
                type="button"
                key={route.id}
                onClick={() => {
                  setSelectedRouteId(route.id)
                  zoomToRoute(route)
                  setShowRoutePopup(true)
                }}
                className={`route-card ${active ? 'active' : ''}`}
              >
                <div className="route-card-duration" aria-hidden={dur === null}>
                  {dur !== null ? (
                    <>
                      <span className="route-duration-value">{dur}</span>
                      <span className="route-duration-unit">min</span>
                    </>
                  ) : (
                    <span className="route-duration-empty">—</span>
                  )}
                </div>
                <div className="route-card-main">
                  <div className="route-card-topline">
                    <span className={`route-mode-chip route-mode-${route.mode}`}>
                      {route.mode === 'transport' ? 'Transports' : 'Marche'}
                    </span>
                    {route.crowdLabel ? (
                      <span className={`crowd-pill crowd-${crowdK}`}>{route.crowdLabel}</span>
                    ) : null}
                  </div>
                  <strong className="route-card-title">{route.title}</strong>
                  {route.mode === 'transport' && route.lineSummary ? (
                    <p className="route-lines">{route.lineSummary}</p>
                  ) : null}
                  {route.mode === 'transport' && route.stationSummary ? (
                    <p className="route-stations">{route.stationSummary}</p>
                  ) : null}
                  {route.mode === 'pedestrian' && route.distanceM ? (
                    <p className="route-meta-foot">{route.distanceM} m</p>
                  ) : null}
                  {route.mode === 'transport' && (route.transferCount ?? 0) > 0 ? (
                    <p className="route-meta-foot">
                      {route.transferCount} correspondance{route.transferCount === 1 ? '' : 's'}
                    </p>
                  ) : null}
                </div>
              </button>
            )
          })}
        </section>

        {selectedRoute?.directions?.length ? (
          <section className="directions-box">
            <h2>Étapes du trajet</h2>
            <ol>
              {(selectedRoute.directionSteps ?? []).map((step, idx) => (
                <li key={`${step.line}-${idx}`} className="direction-step">
                  <span className={`line-badge line-${step.mode}`}>
                    {badgeText(step.mode, step.line)}
                  </span>
                  <span>{step.text}</span>
                </li>
              ))}
            </ol>
          </section>
        ) : null}

        <p className="brand-footer">Calm Move · Île-de-France</p>
      </aside>

      <section className="map-wrap">
        <button type="button" className="locate-btn" onClick={requestUserLocation}>
          <span className="locate-btn-icon" aria-hidden>
            ◎
          </span>
          Position
        </button>
        {!MAPBOX_TOKEN ? (
          <div className="mapbox-missing-token">
            Ajoute `VITE_MAPBOX_TOKEN` dans `frontend/.env` pour afficher la carte Mapbox.
          </div>
        ) : (
          <Map
            ref={mapRef}
            mapboxAccessToken={MAPBOX_TOKEN}
            initialViewState={{ longitude: center[0], latitude: center[1], zoom: 12 }}
            mapStyle="mapbox://styles/mapbox/streets-v12"
            style={{ width: '100%', height: '100%' }}
          >
            {routes.map((route) => (
              <Source
                key={route.id}
                id={`route-${route.id}`}
                type="geojson"
                data={{
                  type: 'Feature',
                  properties: {},
                  geometry: {
                    type: 'LineString',
                    coordinates: route.points,
                  },
                }}
              >
                <Layer
                  id={`line-casing-${route.id}`}
                  type="line"
                  paint={{
                    'line-color': '#0a1020',
                    'line-width': route.id === selectedRoute?.id ? 12 : 8,
                    'line-opacity': route.id === selectedRoute?.id ? 0.85 : 0.55,
                  }}
                />
                <Layer
                  id={`line-${route.id}`}
                  type="line"
                  paint={{
                    'line-color': route.routeColor,
                    'line-width': route.id === selectedRoute?.id ? 8.5 : 5.5,
                    'line-opacity': route.id === selectedRoute?.id ? 1 : 0.8,
                  }}
                />
              </Source>
            ))}

            {selectedRoute?.points?.length ? (
              <>
                <Marker longitude={selectedRoute.points[0][0]} latitude={selectedRoute.points[0][1]}>
                  <span className="route-endpoint start">S</span>
                </Marker>
                <Marker
                  longitude={selectedRoute.points[selectedRoute.points.length - 1][0]}
                  latitude={selectedRoute.points[selectedRoute.points.length - 1][1]}
                >
                  <span className="route-endpoint end">A</span>
                </Marker>
              </>
            ) : null}

            {selectedRoute?.mode === 'pedestrian' &&
              (selectedRoute.heatPoints ?? []).map((p, idx) => (
                <Marker key={`${idx}-${p.lat}-${p.lng}`} longitude={p.lng} latitude={p.lat}>
                  <span
                    style={{
                      display: 'inline-block',
                      width: '10px',
                      height: '10px',
                      borderRadius: '50%',
                      background: p.busyness_score > 40 ? '#c62828' : '#2e7d32',
                      border: '1px solid #ffffff',
                    }}
                  />
                </Marker>
              ))}

            {userLocation ? (
              <Marker longitude={userLocation.lng} latitude={userLocation.lat}>
                <span className="user-location-marker" title="Votre position">
                  <span className="user-location-pulse" />
                  {userLocation.heading !== null ? (
                    <span
                      className="user-location-heading"
                      style={{ transform: `translateX(-50%) rotate(${userLocation.heading}deg)` }}
                    />
                  ) : null}
                  <span className="user-location-dot" />
                </span>
              </Marker>
            ) : null}
          </Map>
        )}
      </section>

      {showRoutePopup && selectedRoute ? (
        <div className="route-popup-floating">
          <article className="route-popup">
            <header className="route-popup-header">
              <div>
                <p className="popup-eyebrow">Détail du trajet</p>
                <h3>{selectedRoute.title}</h3>
                {selectedRoute.stationSummary ? <p className="popup-sub">{selectedRoute.stationSummary}</p> : null}
              </div>
              <button type="button" className="popup-close" onClick={() => setShowRoutePopup(false)}>
                Fermer
              </button>
            </header>

            <div className="popup-kpis">
              {selectedRoute.crowdLabel ? (
                <span className={`crowd-pill crowd-${crowdKeyFromLabel(selectedRoute.crowdLabel)}`}>
                  {selectedRoute.crowdLabel}
                </span>
              ) : null}
              {selectedRoute.durationMin ? (
                <span className="popup-kpi-time">{Math.round(selectedRoute.durationMin)} min</span>
              ) : null}
              {selectedRoute.mode === 'transport' && (selectedRoute.transferCount ?? 0) > 0 ? (
                <span className="popup-kpi-muted">
                  {selectedRoute.transferCount} corresp.
                </span>
              ) : null}
            </div>

            <div className="popup-steps">
              {(selectedRoute.directionSteps ?? []).map((step, idx) => (
                <div className="popup-step" key={`${selectedRoute.id}-step-${idx}`}>
                  <span className={`line-badge line-${step.mode}`}>{badgeText(step.mode, step.line)}</span>
                  <p>{step.text}</p>
                </div>
              ))}
            </div>
          </article>
        </div>
      ) : null}
    </main>
  )
}

export default App
