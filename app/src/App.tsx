import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import './App.css'

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN

const GTA_SW: [number, number] = [-80.2, 43.3]
const GTA_NE: [number, number] = [-78.8, 44.3]
const EDGE_MARGIN = 0.05

// ─── Interfaces ────────────────────────────────────────────────

interface FacilityProperties {
  name: string
  type: string
  city: string
  address: string
  outage_risk_score: number
  solar_potential_score: number
  solar_kwh_per_m2?: number
  facility_score: number
  final_score: number
  rank: number
}

interface Facility {
  properties: FacilityProperties
  geometry: { coordinates: [number, number] }
}

// Task 1
interface PlacedCharger {
  id: string
  lngLat: mapboxgl.LngLat
}

interface NrelStation {
  latitude: number
  longitude: number
  ev_level2_evse_num: number | null
  ev_dc_fast_num: number | null
  station_name: string
}

// Task 2
interface RenewableInstall {
  lat: number
  lng: number
  installType: string
  size: number
}

// Task 5
interface IslandResult {
  hours: number
  label: string
  color: string
}

// ─── Pure helpers ──────────────────────────────────────────────

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function getFacilityDemandKw(type: string): number {
  const t = type.toLowerCase()
  if (t.includes('hospital')) return 2000
  if (t.includes('nursing') || t.includes('residential care')) return 500
  return 150
}

function calcSurvivalHours(
  facility: Facility,
  nrelStations: NrelStation[],
  placedChargers: PlacedCharger[],
  allFeatures: Facility[],
): IslandResult {
  const [lng, lat] = facility.geometry.coordinates

  let chargerCount = 0
  for (const st of nrelStations) {
    if (haversineKm(lat, lng, st.latitude, st.longitude) <= 1) {
      chargerCount += (st.ev_level2_evse_num ?? 0) + (st.ev_dc_fast_num ?? 0)
    }
  }
  for (const pc of placedChargers) {
    if (haversineKm(lat, lng, pc.lngLat.lat, pc.lngLat.lng) <= 1) chargerCount++
  }

  let solarSum = 0, solarCount = 0
  for (const f of allFeatures) {
    const [flng, flat] = f.geometry.coordinates
    if (haversineKm(lat, lng, flat, flng) <= 1) {
      solarSum += f.properties.solar_kwh_per_m2 ?? 0
      solarCount++
    }
  }
  const avgSolarKwhM2 = solarCount > 0 ? solarSum / solarCount : 0

  const evKwh = chargerCount * 60 * 0.8
  const solarKwh = avgSolarKwhM2 * 500 * (6 / 24)
  const totalKwh = evKwh + solarKwh
  const demandKw = getFacilityDemandKw(facility.properties.type)
  const hours = demandKw > 0 ? totalKwh / demandKw : 0

  const label = hours < 4 ? 'Critical' : hours < 24 ? 'Limited' : 'Resilient'
  const color = hours < 4 ? '#ef4444' : hours < 24 ? '#f97316' : '#22c55e'
  return { hours: Math.round(hours * 10) / 10, label, color }
}

function getScoreColor(score: number): string {
  if (score >= 80) return '#ef4444'
  if (score >= 60) return '#f97316'
  if (score >= 40) return '#eab308'
  return '#22c55e'
}

function clampFlyCoords(lng: number, lat: number): [number, number] {
  return [
    Math.max(GTA_SW[0] + EDGE_MARGIN, Math.min(GTA_NE[0] - EDGE_MARGIN, lng)),
    Math.max(GTA_SW[1] + EDGE_MARGIN, Math.min(GTA_NE[1] - EDGE_MARGIN, lat)),
  ]
}

// ─── ScoreBar ──────────────────────────────────────────────────

function ScoreBar({ value, label }: { value: number; label: string }) {
  const pct = value * 100
  const col = pct >= 80 ? '#ef4444' : pct >= 60 ? '#f97316' : pct >= 40 ? '#eab308' : '#22c55e'
  return (
    <div style={{ marginBottom: '10px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', marginBottom: '4px' }}>
        <span style={{ color: 'rgba(255,255,255,0.5)', textShadow: '0 1px 2px rgba(0,0,0,0.6)' }}>{label}</span>
        <span style={{ color: 'rgba(255,255,255,0.85)', textShadow: '0 1px 2px rgba(0,0,0,0.6)' }}>{pct.toFixed(0)}%</span>
      </div>
      <div style={{
        background: 'rgba(255,255,255,0.08)', backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)', border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: '4px', height: '5px',
      }}>
        <div style={{
          background: `linear-gradient(90deg, ${col}88, ${col})`,
          boxShadow: `0 0 10px ${col}99`, width: `${pct}%`, height: '100%', borderRadius: '4px',
        }} />
      </div>
    </div>
  )
}

// ─── Task 2 — Reliability Chart ────────────────────────────────

function ReliabilityChart({ startScore, installType }: { startScore: number; installType: string }) {
  const lower = installType.toLowerCase()
  const degradeRate = lower.includes('wind') ? 0.3 : lower.includes('fit') || lower.includes('solar') ? 0.5 : 0.2
  const years = Array.from({ length: 26 }, (_, i) => i)
  const scores = years.map(y => Math.max(0, startScore - y * degradeRate))
  const viableYear = years.find(y => scores[y] <= 40) ?? 25

  const W = 220, H = 90
  const pad = { l: 28, r: 8, t: 8, b: 20 }
  const cW = W - pad.l - pad.r
  const cH = H - pad.t - pad.b
  const xS = (y: number) => pad.l + (y / 25) * cW
  const yS = (s: number) => pad.t + (1 - s / 100) * cH
  const pathD = scores.map((s, i) => `${i === 0 ? 'M' : 'L'} ${xS(i).toFixed(1)} ${yS(s).toFixed(1)}`).join(' ')
  const ty = yS(40)

  return (
    <div>
      <svg width={W} height={H} style={{ display: 'block', overflow: 'visible' }}>
        <text x={pad.l - 4} y={pad.t + 4} textAnchor="end" fontSize="8" fill="rgba(255,255,255,0.35)">100</text>
        <text x={pad.l - 4} y={ty + 3} textAnchor="end" fontSize="8" fill="rgba(239,68,68,0.7)">40</text>
        <text x={pad.l - 4} y={H - pad.b + 3} textAnchor="end" fontSize="8" fill="rgba(255,255,255,0.35)">0</text>
        <text x={pad.l} y={H} textAnchor="middle" fontSize="8" fill="rgba(255,255,255,0.3)">0</text>
        <text x={W - pad.r} y={H} textAnchor="middle" fontSize="8" fill="rgba(255,255,255,0.3)">25yr</text>
        <line x1={pad.l} y1={ty} x2={W - pad.r} y2={ty}
          stroke="rgba(239,68,68,0.5)" strokeWidth="1" strokeDasharray="4,3" />
        <path d={pathD} fill="none" stroke="#06b6d4" strokeWidth="1.5" />
        {viableYear < 25 && (
          <line x1={xS(viableYear)} y1={pad.t} x2={xS(viableYear)} y2={H - pad.b}
            stroke="rgba(239,68,68,0.4)" strokeWidth="1" strokeDasharray="2,2" />
        )}
      </svg>
      <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.45)', marginTop: '4px' }}>
        Estimated viable lifespan:{' '}
        <span style={{ color: '#06b6d4', fontWeight: 600 }}>{viableYear} years</span>
        {' '}· {degradeRate}%/yr degradation
      </div>
    </div>
  )
}

// ─── Glass helpers ─────────────────────────────────────────────

const glass: React.CSSProperties = {
  background: 'rgba(255, 255, 255, 0.10)',
  backdropFilter: 'blur(60px) saturate(200%)',
  WebkitBackdropFilter: 'blur(60px) saturate(200%)',
  border: '1px solid rgba(255, 255, 255, 0.20)',
  borderRadius: '20px',
  boxShadow: '0 8px 32px rgba(0,0,0,0.45), 0 2px 8px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.18), inset 0 0 20px rgba(255,255,255,0.05)',
  color: 'white',
}

function GlassTopHighlight() {
  return (
    <div style={{
      position: 'absolute', top: 0, left: '10%', right: '10%', height: '1px',
      background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.35), transparent)',
      pointerEvents: 'none',
    }} />
  )
}

// ─── App ───────────────────────────────────────────────────────

export default function App() {
  // refs
  const mapContainer = useRef<HTMLDivElement>(null)
  const cityContainer = useRef<HTMLDivElement>(null)
  const map = useRef<mapboxgl.Map | null>(null)
  const popup = useRef<mapboxgl.Popup | null>(null)
  const animRef = useRef<number>(0)
  const cityFocusRef = useRef<((f: Facility) => void) | null>(null)
  const cityResetRef = useRef<(() => void) | null>(null)
  const placedMarkerRefs = useRef<Record<string, mapboxgl.Marker>>({})
  const nrelMarkerRefs = useRef<mapboxgl.Marker[]>([])
  const placedChargersRef = useRef<PlacedCharger[]>([])
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // core state
  const [viewMode, setViewMode] = useState<'map' | 'city'>('map')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [selected, setSelected] = useState<Facility | null>(null)
  const [topFacilities, setTopFacilities] = useState<Facility[]>([])
  const [allFeatures, setAllFeatures] = useState<Facility[]>([])
  const [minScore, setMinScore] = useState(0)
  const [mapLoaded, setMapLoaded] = useState(false)
  const [tooltip, setTooltip] = useState<{ x: number; y: number; name: string; score: number } | null>(null)
  const [outageData, setOutageData] = useState<GeoJSON.FeatureCollection | null>(null)
  const [outageStatus, setOutageStatus] = useState<'loading' | 'ok' | 'no-outages' | 'error'>('loading')
  const [outageVisible, setOutageVisible] = useState(true)
  const [isMobile, setIsMobile] = useState(false)
  const [drawerExpanded, setDrawerExpanded] = useState(false)

  // Task 1 — DER
  const [placedChargers, setPlacedChargers] = useState<PlacedCharger[]>([])
  const [nrelStations, setNrelStations] = useState<NrelStation[]>([])
  const [derCoverage, setDerCoverage] = useState<Record<string, number>>({})
  const [coverageFilter, setCoverageFilter] = useState<'all' | 'uncovered' | 'covered'>('all')
  const [derConfirmed, setDerConfirmed] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  // Task 2 — reliability
  const [renewableInstalls, setRenewableInstalls] = useState<RenewableInstall[]>([])
  const [reliabilityOpen, setReliabilityOpen] = useState(false)

  // Task 4 — utility lines
  const [utilityLinesVisible, setUtilityLinesVisible] = useState(true)

  // Task 5 — island mode
  const [islandResult, setIslandResult] = useState<IslandResult | null>(null)
  const [islandHours, setIslandHours] = useState(24)

  // keep placed chargers in sync with ref so map event handlers can read current value
  useEffect(() => { placedChargersRef.current = placedChargers }, [placedChargers])

  // reset panel state when selection changes
  useEffect(() => {
    setIslandResult(null)
    setIslandHours(24)
    setReliabilityOpen(false)
  }, [selected])

  // ── mobile detection ────────────────────────────────────────
  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth < 768)
      map.current?.resize()
    }
    handleResize()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  // ── load facilities (sidebar independent of map) ────────────
  useEffect(() => {
    fetch('./facilities.geojson')
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        if (!data) return
        const sorted = [...data.features].sort(
          (a: Facility, b: Facility) => b.properties.final_score - a.properties.final_score
        )
        setTopFacilities(sorted.slice(0, 10))
        setAllFeatures(data.features)
      })
      .catch(() => {})
  }, [])

  // ── Task 1: fetch NREL existing chargers ────────────────────
  useEffect(() => {
    fetch(
      'https://developer.nrel.gov/api/alt-fuel-stations/v1.json?api_key=DEMO_KEY&fuel_type=ELEC&city=Toronto&state=ON&country=CA&limit=100'
    )
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        if (!data?.fuel_stations) return
        setNrelStations(
          (data.fuel_stations as NrelStation[]).filter(s => s.latitude && s.longitude)
        )
      })
      .catch(() => {})
  }, [])

  // place grey NREL reference markers on map once both are ready
  useEffect(() => {
    if (!mapLoaded || !map.current || nrelStations.length === 0) return
    nrelMarkerRefs.current.forEach(m => m.remove())
    nrelMarkerRefs.current = []
    for (const st of nrelStations) {
      const el = document.createElement('div')
      el.style.cssText = [
        'width:12px;height:12px;border-radius:50%',
        'background:rgba(120,120,120,0.6);border:1.5px solid rgba(180,180,180,0.4)',
        'display:flex;align-items:center;justify-content:center',
        'font-size:7px;color:rgba(255,255,255,0.7);pointer-events:none',
      ].join(';')
      el.textContent = '⚡'
      const m = new mapboxgl.Marker({ element: el })
        .setLngLat([st.longitude, st.latitude])
        .addTo(map.current!)
      nrelMarkerRefs.current.push(m)
    }
  }, [mapLoaded, nrelStations])

  // ── Task 2: load renewable installations CSV ─────────────────
  useEffect(() => {
    fetch('./Renewable_Energy_Installations_2026.csv')
      .then(r => (r.ok ? r.text() : null))
      .then(text => {
        if (!text) return
        const lines = text.split('\n')
        const header = lines[0].split(',').map(h => h.replace(/"/g, '').trim())
        const lngIdx = header.findIndex(h => h.toUpperCase() === 'LONGITUDE')
        const latIdx = header.findIndex(h => h.toUpperCase() === 'LATITUDE')
        const typeIdx = header.findIndex(h => h.toUpperCase() === 'TYPE_INSTALL')
        const sizeIdx = header.findIndex(h => h.toUpperCase() === 'SIZE_INSTALL')
        const installs: RenewableInstall[] = []
        for (let i = 1; i < lines.length; i++) {
          const cols = lines[i].split(',')
          const lat = parseFloat(cols[latIdx])
          const lng = parseFloat(cols[lngIdx])
          if (!isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0) {
            installs.push({
              lat, lng,
              installType: cols[typeIdx]?.replace(/"/g, '').trim() || 'Other',
              size: parseFloat(cols[sizeIdx]) || 0,
            })
          }
        }
        setRenewableInstalls(installs)
      })
      .catch(() => {})
  }, [])

  // ── KUBRA live outage fetch ──────────────────────────────────
  useEffect(() => {
    const KUBRA_URL =
      '/kubra-api/stormcenter/api/v1/stormcenters/b8d8094c-3809-49e5-bf8b-1ddd27f6e12d/views/5c2283d7-eff9-4f7e-966b-3afd90d8a6b9/currentState?preview=false'
    const fetchOutages = async () => {
      try {
        const res = await fetch(KUBRA_URL, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'Origin': window.location.origin,
          },
          mode: 'cors',
        })
        if (!res.ok) throw new Error(`KUBRA ${res.status}`)
        const json = await res.json()
        console.log('KUBRA response:', json)
        const dataUrl: string | undefined =
          json?.data?.file_data || json?.data?.fileData || json?.file_data ||
          json?.fileData || json?.data?.report_url || json?.report_url
        if (dataUrl) {
          const geoRes = await fetch(dataUrl)
          if (!geoRes.ok) throw new Error(`GeoJSON ${geoRes.status}`)
          const geo = await geoRes.json()
          setOutageData(geo)
          setOutageStatus((geo.features?.length ?? 0) > 0 ? 'ok' : 'no-outages')
        } else if (json?.type === 'FeatureCollection' || json?.features) {
          setOutageData(json as GeoJSON.FeatureCollection)
          setOutageStatus(((json as GeoJSON.FeatureCollection).features?.length ?? 0) > 0 ? 'ok' : 'no-outages')
        } else {
          setOutageStatus('no-outages')
        }
      } catch { setOutageStatus('error') }
    }
    fetchOutages()
    const interval = setInterval(fetchOutages, 10 * 60 * 1000)
    return () => clearInterval(interval)
  }, [])

  // ── flyTo ────────────────────────────────────────────────────
  const flyTo = useCallback((f: Facility) => {
    if (!map.current) return
    const [lng, lat] = f.geometry.coordinates
    const [clampedLng, clampedLat] = clampFlyCoords(lng, lat)
    map.current.flyTo({ center: [clampedLng, clampedLat], zoom: 14, pitch: 60, bearing: -20, duration: 1600, essential: true })
    popup.current?.remove()
    popup.current = new mapboxgl.Popup({ closeButton: false, offset: 14, className: 'mg-popup' })
      .setLngLat(f.geometry.coordinates)
      .setHTML(`
        <div class="mg-popup-inner">
          <div class="mg-popup-name">${f.properties.name}</div>
          <div class="mg-popup-city">${f.properties.city}</div>
          <div class="mg-popup-score" style="color:${getScoreColor(f.properties.final_score)}">
            ${f.properties.final_score}<span class="mg-popup-denom">/100</span>
          </div>
          <div class="mg-popup-rank">Rank #${f.properties.rank} of 906</div>
        </div>
      `)
      .addTo(map.current)
  }, [])

  const toggleDrawer = useCallback(() => {
    setDrawerExpanded(v => !v)
    setTimeout(() => map.current?.resize(), 320)
  }, [])

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    toastTimerRef.current = setTimeout(() => setToast(null), 3500)
  }, [])

  // ── map pulse animation ──────────────────────────────────────
  useEffect(() => {
    if (!mapLoaded) return
    let t0: number | null = null
    const tick = (ts: number) => {
      if (!t0) t0 = ts
      const elapsed = (ts - t0) / 1000
      const pulseOpacity = 0.1 + 0.22 * Math.abs(Math.sin(elapsed * 1.3))
      const ringOpacity = 0.3 + 0.55 * Math.abs(Math.sin(elapsed * 1.8))
      if (map.current?.getLayer('facilities-pulse')) map.current.setPaintProperty('facilities-pulse', 'circle-opacity', pulseOpacity)
      if (map.current?.getLayer('top5-ring')) map.current.setPaintProperty('top5-ring', 'circle-stroke-opacity', ringOpacity)
      animRef.current = requestAnimationFrame(tick)
    }
    animRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(animRef.current)
  }, [mapLoaded])

  // ── push outage GeoJSON to map ───────────────────────────────
  useEffect(() => {
    if (!mapLoaded || !map.current || !outageData) return
    const src = map.current.getSource('outages') as mapboxgl.GeoJSONSource
    if (src) src.setData(outageData)
  }, [outageData, mapLoaded])

  // ── toggle outage layer ──────────────────────────────────────
  useEffect(() => {
    if (!mapLoaded || !map.current) return
    if (map.current.getLayer('outage-layer'))
      map.current.setLayoutProperty('outage-layer', 'visibility', outageVisible ? 'visible' : 'none')
  }, [outageVisible, mapLoaded])

  // ── Task 4: toggle utility lines ────────────────────────────
  useEffect(() => {
    if (!mapLoaded || !map.current) return
    if (map.current.getLayer('utility-lines'))
      map.current.setLayoutProperty('utility-lines', 'visibility', utilityLinesVisible ? 'visible' : 'none')
  }, [utilityLinesVisible, mapLoaded])

  // ── score filter + coverage sync ─────────────────────────────
  useEffect(() => {
    if (!mapLoaded || !map.current) return
    const src = map.current.getSource('facilities') as mapboxgl.GeoJSONSource
    if (!src) return
    const getCovStatus = (name: string) => {
      const count = derCoverage[name] ?? 0
      if (count === 0) return 'uncovered'
      if (count <= 2) return 'partial'
      return 'covered'
    }
    src.setData({
      type: 'FeatureCollection',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      features: allFeatures
        .filter(f => f.properties.final_score >= minScore)
        .map(f => ({ ...f, properties: { ...f.properties, coverage: getCovStatus(f.properties.name) } })) as any,
    })
  }, [minScore, allFeatures, mapLoaded, derCoverage])

  // ── map initialisation ───────────────────────────────────────
  useEffect(() => {
    if (map.current || !mapContainer.current) return
    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/navigation-night-v1',
      center: [-79.38, 43.65], zoom: 10, pitch: 45, bearing: 0,
      antialias: true, maxBounds: [GTA_SW, GTA_NE], maxPitch: 60, minZoom: 8, maxZoom: 18,
    })
    map.current.on('load', async () => {
      const m = map.current!
      m.resize()
      ;(m as unknown as { setFog: (o: object) => void }).setFog({
        color: 'rgba(0,0,0,0)', 'high-color': 'rgba(0,0,0,0)',
        'horizon-blend': 0, 'space-color': 'rgba(0,0,0,0)', 'star-intensity': 0,
      })

      const res = await fetch('./facilities.geojson')
      const data = await res.json()
      const sorted = [...data.features].sort((a: Facility, b: Facility) => b.properties.final_score - a.properties.final_score)
      setTopFacilities(sorted.slice(0, 10))
      setAllFeatures(data.features)
      m.addSource('facilities', { type: 'geojson', data })

      if (m.getSource('composite')) {
        m.addLayer({
          id: '3d-buildings', source: 'composite', 'source-layer': 'building',
          filter: ['==', 'extrude', 'true'], type: 'fill-extrusion', minzoom: 12,
          paint: {
            'fill-extrusion-color': ['interpolate', ['linear'], ['get', 'height'], 0, '#0d1b2a', 15, '#0f2744', 40, '#1e3a5f', 80, '#1a4a8a', 150, '#1d5ecc', 250, '#2563eb'],
            'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 12, 0, 12.5, ['get', 'height']],
            'fill-extrusion-base': ['get', 'min_height'], 'fill-extrusion-opacity': 0.88,
          },
        })
      }

      m.addSource('outages', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      m.addLayer({ id: 'outage-layer', type: 'fill', source: 'outages', paint: { 'fill-color': '#ff4444', 'fill-opacity': 0.35 } })

      // Task 4 — utility lines layer (inserted before facility dots)
      m.addSource('utility-lines', { type: 'geojson', data: '/Utility_Line.geojson' })
      m.addLayer(
        { id: 'utility-lines', type: 'line', source: 'utility-lines',
          layout: { visibility: 'visible' },
          paint: { 'line-color': 'rgba(0,200,255,0.35)', 'line-width': 1 } },
        'outage-layer'
      )

      m.addLayer({ id: 'facilities-halo', type: 'circle', source: 'facilities', filter: ['>=', ['get', 'final_score'], 80], paint: { 'circle-radius': ['interpolate', ['linear'], ['get', 'final_score'], 80, 18, 100, 26], 'circle-color': '#ef4444', 'circle-opacity': 0.13, 'circle-blur': 0.85 } })
      m.addLayer({ id: 'facilities-pulse', type: 'circle', source: 'facilities', filter: ['>=', ['get', 'final_score'], 60], paint: { 'circle-radius': ['interpolate', ['linear'], ['get', 'final_score'], 60, 11, 100, 20], 'circle-color': ['interpolate', ['linear'], ['get', 'final_score'], 60, '#f97316', 80, '#ef4444'], 'circle-opacity': 0.2, 'circle-blur': 0.55 } })
      m.addLayer({ id: 'top5-ring', type: 'circle', source: 'facilities', filter: ['<=', ['get', 'rank'], 5], paint: { 'circle-radius': 32, 'circle-color': 'rgba(0,0,0,0)', 'circle-opacity': 0, 'circle-stroke-width': 2.5, 'circle-stroke-color': '#ef4444', 'circle-stroke-opacity': 0.6 } })
      m.addLayer({
        id: 'der-coverage-rings', type: 'circle', source: 'facilities',
        paint: {
          'circle-radius': 14,
          'circle-color': ['case', ['==', ['get', 'coverage'], 'covered'], 'rgba(34,197,94,0.25)', ['==', ['get', 'coverage'], 'partial'], 'rgba(234,179,8,0.25)', 'rgba(0,0,0,0)'],
          'circle-stroke-width': 1.5,
          'circle-stroke-color': ['case', ['==', ['get', 'coverage'], 'covered'], 'rgba(34,197,94,0.6)', ['==', ['get', 'coverage'], 'partial'], 'rgba(234,179,8,0.6)', 'rgba(0,0,0,0)'],
        },
      })
      m.addLayer({ id: 'facilities-layer', type: 'circle', source: 'facilities', paint: { 'circle-radius': ['interpolate', ['linear'], ['get', 'final_score'], 0, 5, 100, 13], 'circle-color': ['interpolate', ['linear'], ['get', 'final_score'], 0, '#22c55e', 40, '#eab308', 60, '#f97316', 80, '#ef4444'], 'circle-opacity': 0.92, 'circle-stroke-width': 1.5, 'circle-stroke-color': 'rgba(255,255,255,0.55)' } })

      m.on('click', 'facilities-layer', (e) => {
        if (!e.features?.[0]) return
        const feat = e.features[0]
        const facility: Facility = {
          properties: feat.properties as FacilityProperties,
          geometry: { coordinates: (feat.geometry as GeoJSON.Point).coordinates as [number, number] },
        }
        setSelected(facility); flyTo(facility)
      })
      m.on('mouseenter', 'facilities-layer', () => { m.getCanvas().style.cursor = 'pointer' })
      m.on('mouseleave', 'facilities-layer', () => { m.getCanvas().style.cursor = '' })

      setMapLoaded(true)
      setTimeout(() => {
        m.flyTo({ center: [-79.38, 43.72], zoom: 11, pitch: 45, bearing: 0, duration: 3400, essential: true, easing: (t) => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t })
      }, 450)
    })
  }, [flyTo])

  // ── Task 1: confirm DER placement ───────────────────────────
  const confirmDERPlacement = useCallback(() => {
    const chargers = placedChargersRef.current
    if (chargers.length === 0) return

    const newCoverage: Record<string, number> = { ...derCoverage }
    for (const c of chargers) {
      for (const f of allFeatures) {
        const [flng, flat] = f.geometry.coordinates
        if (haversineKm(flat, flng, c.lngLat.lat, c.lngLat.lng) <= 1) {
          newCoverage[f.properties.name] = (newCoverage[f.properties.name] ?? 0) + 1
        }
      }
    }

    const coveredCount = Object.keys(newCoverage).length
    setDerCoverage(newCoverage)
    showToast(`Coverage applied — ${coveredCount} facilities now have DER coverage`)
    setDerConfirmed(true)
    setTimeout(() => map.current?.resize(), 50)
  }, [allFeatures, derCoverage, showToast])

  // ── Task 1: handle drop on map canvas ───────────────────────
  const handleMapDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    if (!map.current || !mapContainer.current) return
    const rect = mapContainer.current.getBoundingClientRect()
    const lngLat = map.current.unproject([e.clientX - rect.left, e.clientY - rect.top])
    const id = `ev-${Date.now()}`

    const el = document.createElement('div')
    el.style.cssText = [
      'width:22px;height:22px;border-radius:50%',
      'background:rgba(20,184,166,0.85);border:2px solid rgba(94,234,212,0.8)',
      'display:flex;align-items:center;justify-content:center',
      'font-size:11px;cursor:pointer',
      'box-shadow:0 0 10px rgba(20,184,166,0.6)',
    ].join(';')
    el.textContent = '⚡'
    el.title = 'Right-click to remove'
    el.addEventListener('contextmenu', ev => {
      ev.preventDefault()
      placedMarkerRefs.current[id]?.remove()
      delete placedMarkerRefs.current[id]
      setPlacedChargers(prev => prev.filter(c => c.id !== id))
    })

    const marker = new mapboxgl.Marker({ element: el }).setLngLat(lngLat).addTo(map.current)
    placedMarkerRefs.current[id] = marker
    setDerConfirmed(false)
    setPlacedChargers(prev => [...prev, { id, lngLat }])
  }, [])

  // ── Task 5: run island mode simulation ──────────────────────
  const runIslandMode = useCallback(() => {
    if (!selected) return
    setIslandResult(calcSurvivalHours(selected, nrelStations, placedChargersRef.current, allFeatures))
  }, [selected, nrelStations, allFeatures])

  // ── Task 5: pre-calculate survival hours for top 10 ─────────
  const facilityIslandHours = useMemo<Record<string, number>>(() => {
    if (nrelStations.length === 0 || allFeatures.length === 0) return {}
    const out: Record<string, number> = {}
    for (const f of topFacilities)
      out[f.properties.name] = calcSurvivalHours(f, nrelStations, [], allFeatures).hours
    return out
  }, [topFacilities, nrelStations, allFeatures])

  // ── Three.js city model ──────────────────────────────────────
  useEffect(() => {
    if (viewMode !== 'city' || !cityContainer.current || allFeatures.length === 0) return

    const container = cityContainer.current
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x0a0f1e)
    scene.fog = new THREE.FogExp2(0x0a0f1e, 0.004)

    const w = container.clientWidth, h = container.clientHeight
    const camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1000)
    camera.position.set(30, 100, 130)
    camera.lookAt(0, 10, 0)

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setSize(w, h)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.domElement.style.display = 'block'
    container.appendChild(renderer.domElement)

    scene.add(new THREE.AmbientLight(0xffffff, 0.4))
    const dirLight = new THREE.DirectionalLight(0x4facfe, 1.2)
    dirLight.position.set(50, 100, 50)
    scene.add(dirLight)
    scene.add(new THREE.PointLight(0x3b82f6, 0.8, 200))
    scene.add(new THREE.HemisphereLight(0x1e3a5f, 0x0a0f1e, 0.5))

    const gnd = new THREE.Mesh(
      new THREE.PlaneGeometry(250, 250),
      new THREE.MeshPhongMaterial({ color: 0x050b18, shininess: 5 })
    )
    gnd.rotation.x = -Math.PI / 2; gnd.position.y = -0.1; scene.add(gnd)

    const starPos = new Float32Array(2000 * 3)
    for (let i = 0; i < 2000; i++) {
      starPos[i * 3] = (Math.random() - 0.5) * 800
      starPos[i * 3 + 1] = Math.random() * 300 + 100
      starPos[i * 3 + 2] = (Math.random() - 0.5) * 800
    }
    const starGeo = new THREE.BufferGeometry()
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3))
    scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.3 })))

    const winCanvas = document.createElement('canvas')
    winCanvas.width = 64; winCanvas.height = 128
    const winCtx = winCanvas.getContext('2d')!
    winCtx.fillStyle = '#000810'; winCtx.fillRect(0, 0, 64, 128)
    for (let wx = 4; wx < 60; wx += 9) {
      for (let wy = 4; wy < 124; wy += 9) {
        if (Math.random() > 0.3) {
          winCtx.fillStyle = Math.random() > 0.5
            ? `rgba(255,248,200,${(0.6 + Math.random() * 0.4).toFixed(2)})`
            : `rgba(180,220,255,${(0.5 + Math.random() * 0.35).toFixed(2)})`
          winCtx.fillRect(wx, wy, 4, 5)
        }
      }
    }
    const winTex = new THREE.CanvasTexture(winCanvas)
    const winMat = new THREE.MeshBasicMaterial({ map: winTex, transparent: true, opacity: 0.75 })

    type Zone = { xMin: number; xMax: number; zMin: number; zMax: number; heightMin: number; heightMax: number; color: number; spacing: number; isDowntown?: boolean }
    const zones: Zone[] = [
      { xMin: -5,  xMax: 5,   zMin: -5,  zMax: 5,   heightMin: 15, heightMax: 60, color: 0x2563eb, spacing: 1.4, isDowntown: true },
      { xMin: -10, xMax: 10,  zMin: -15, zMax: -5,  heightMin: 8,  heightMax: 20, color: 0x1e3a5f, spacing: 2.0 },
      { xMin: -20, xMax: 20,  zMin: -30, zMax: -15, heightMin: 3,  heightMax: 12, color: 0x0d1b2a, spacing: 2.5 },
      { xMin: -40, xMax: -20, zMin: -10, zMax: 20,  heightMin: 2,  heightMax: 6,  color: 0x0a1628, spacing: 3.5 },
      { xMin: -30, xMax: -15, zMin: -10, zMax: 10,  heightMin: 4,  heightMax: 15, color: 0x1e3a5f, spacing: 2.5 },
    ]
    for (const zone of zones) {
      const matShort = new THREE.MeshPhongMaterial({ color: zone.color, shininess: 100, specular: 0x224488, emissive: zone.color, emissiveIntensity: 0.2 })
      const matTall  = new THREE.MeshPhongMaterial({ color: zone.color, shininess: 100, specular: 0x224488, emissive: zone.color, emissiveIntensity: 0.5 })
      for (let bx = zone.xMin + zone.spacing / 2; bx < zone.xMax; bx += zone.spacing) {
        for (let bz = zone.zMin + zone.spacing / 2; bz < zone.zMax; bz += zone.spacing) {
          if (Math.random() > 0.15) {
            const bh = zone.heightMin + Math.random() * (zone.heightMax - zone.heightMin)
            const bw = zone.spacing * 0.65 + Math.random() * 0.2
            const bd = zone.spacing * 0.65 + Math.random() * 0.2
            const b = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), bh > 10 ? matTall : matShort)
            b.position.set(bx + (Math.random() - 0.5) * 0.3, bh / 2, bz + (Math.random() - 0.5) * 0.3)
            if (zone.isDowntown) b.rotation.y = (Math.random() - 0.5) * (5 * Math.PI / 180)
            scene.add(b)
            if (bh > 8) {
              const wm = new THREE.Mesh(new THREE.BoxGeometry(bw * 0.99, bh * 0.99, bd * 0.99), winMat)
              wm.position.copy(b.position); wm.rotation.copy(b.rotation); scene.add(wm)
            }
            if (bh > 15) {
              const bl = new THREE.Mesh(
                new THREE.BoxGeometry(bw * 1.15, bh * 1.05, bd * 1.15),
                new THREE.MeshBasicMaterial({ color: zone.color, opacity: 0.1, transparent: true })
              )
              bl.position.copy(b.position); bl.rotation.copy(b.rotation); scene.add(bl)
            }
          }
        }
      }
    }

    {
      const pts: number[] = []
      for (let rx = -60; rx <= 60; rx += 2) { pts.push(rx, 0.05, -60, rx, 0.05, 60) }
      for (let rz = -60; rz <= 60; rz += 2) { pts.push(-60, 0.05, rz, 60, 0.05, rz) }
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
      scene.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x0f172a, opacity: 0.3, transparent: true })))
    }

    const gridMat = new THREE.LineBasicMaterial({ color: 0x1e40af, opacity: 0.4, transparent: true })
    {
      const pts: number[] = []
      for (let rx = -60; rx <= 60; rx += 5) { pts.push(rx, 0.06, -60, rx, 0.06, 60) }
      for (let rz = -60; rz <= 60; rz += 5) { pts.push(-60, 0.06, rz, 60, 0.06, rz) }
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
      scene.add(new THREE.LineSegments(g, gridMat))
    }

    {
      const yonge = new THREE.Mesh(
        new THREE.PlaneGeometry(0.5, 120),
        new THREE.MeshBasicMaterial({ color: 0x60a5fa, opacity: 0.85, transparent: true })
      )
      yonge.rotation.x = -Math.PI / 2; yonge.position.set(0, 0.08, 0); scene.add(yonge)
    }

    {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute([-60, 0.08, -8, 60, 0.08, -8], 3))
      scene.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x2563eb })))
    }

    {
      const hwy = new THREE.Mesh(
        new THREE.PlaneGeometry(120, 1.0),
        new THREE.MeshBasicMaterial({ color: 0x1d4ed8, opacity: 0.9, transparent: true })
      )
      hwy.rotation.x = -Math.PI / 2; hwy.position.set(0, 0.09, -25); scene.add(hwy)
    }

    for (const hx of [-35, -15]) {
      const hwy = new THREE.Mesh(
        new THREE.PlaneGeometry(0.6, 120),
        new THREE.MeshBasicMaterial({ color: 0x1d4ed8, opacity: 0.75, transparent: true })
      )
      hwy.rotation.x = -Math.PI / 2; hwy.position.set(hx, 0.09, 0); scene.add(hwy)
    }

    const lakeGeo = new THREE.PlaneGeometry(140, 60, 40, 20)
    const lakeMesh = new THREE.Mesh(
      lakeGeo,
      new THREE.MeshStandardMaterial({ color: 0x0369a1, opacity: 0.85, transparent: true, metalness: 0.8, roughness: 0.2 })
    )
    lakeMesh.rotation.x = -Math.PI / 2; lakeMesh.position.set(0, -0.05, 42); scene.add(lakeMesh)
    const lakePosAttr = lakeGeo.attributes.position as THREE.BufferAttribute

    {
      const shore = new THREE.Mesh(
        new THREE.PlaneGeometry(140, 3),
        new THREE.MeshBasicMaterial({ color: 0x0ea5e9, opacity: 0.3, transparent: true })
      )
      shore.rotation.x = -Math.PI / 2; shore.position.set(0, 0.15, 15); scene.add(shore)
    }

    const filteredFeatures = allFeatures.filter(f => f.properties.final_score >= minScore)
    const sharedCylGeo = new THREE.CylinderGeometry(0.8, 0.8, 8, 16)
    const ringGeo = new THREE.RingGeometry(1.2, 2.0, 32)

    type CylEntry = { cylinder: THREE.Mesh; ring: THREE.Mesh; facility: Facility; crown?: THREE.Mesh }
    const cylEntries: CylEntry[] = []

    for (const f of filteredFeatures) {
      const [lng, lat] = f.geometry.coordinates
      const sx = Math.max(-60, Math.min(60, ((lng - (-79.85)) / 1.05) * 120 - 60))
      const sz = Math.max(-60, Math.min(60, ((lat - 43.45) / 0.65) * 120 - 60))

      const isTop1 = f.properties.rank === 1
      const cylH = isTop1 ? 10 : 8
      const cylR = isTop1 ? 1.6 : 0.8
      const baseColor = isTop1 ? new THREE.Color(0xfbbf24) : new THREE.Color(getScoreColor(f.properties.final_score))

      const geo = isTop1 ? new THREE.CylinderGeometry(cylR, cylR, cylH, 16) : sharedCylGeo
      const cyl = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        color: baseColor, emissive: baseColor, emissiveIntensity: isTop1 ? 1.0 : 0.5, roughness: 0.3, metalness: 0.6,
      }))
      cyl.position.set(sx, cylH / 2, sz); scene.add(cyl)

      let crown: THREE.Mesh | undefined
      if (isTop1) {
        crown = new THREE.Mesh(
          new THREE.ConeGeometry(0.9, 2.0, 6),
          new THREE.MeshStandardMaterial({ color: 0xfbbf24, emissive: 0xfbbf24, emissiveIntensity: 1.2, metalness: 0.9, roughness: 0.1 })
        )
        crown.position.set(sx, cylH + 1.0, sz); scene.add(crown)
      }

      const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
        color: baseColor, opacity: 0.6, transparent: true, side: THREE.DoubleSide,
      }))
      ring.rotation.x = -Math.PI / 2; ring.position.set(sx, 0.15, sz); scene.add(ring)
      cylEntries.push({ cylinder: cyl, ring, facility: f, crown })

      if (f.properties.rank <= 5) {
        const pl = new THREE.PointLight(new THREE.Color(getScoreColor(f.properties.final_score)), 2, 15)
        pl.position.set(sx, cylH, sz); scene.add(pl)
      }
    }

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true; controls.dampingFactor = 0.05
    controls.minDistance = 20; controls.maxDistance = 200
    controls.maxPolarAngle = Math.PI / 2.2
    controls.autoRotate = true; controls.autoRotateSpeed = 0.2
    controls.target.set(0, 10, 0); controls.update()
    controls.addEventListener('start', () => { controls.autoRotate = false })

    const lerpCamera = (toPos: THREE.Vector3, toTarget: THREE.Vector3) => {
      const fromPos = camera.position.clone()
      const fromTarget = controls.target.clone()
      const duration = 1200; const start = performance.now()
      controls.autoRotate = false
      const tick = () => {
        const t = Math.min((performance.now() - start) / duration, 1)
        const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t
        camera.position.lerpVectors(fromPos, toPos, ease)
        controls.target.lerpVectors(fromTarget, toTarget, ease)
        controls.update(); if (t < 1) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    }

    cityResetRef.current = () => lerpCamera(new THREE.Vector3(30, 100, 130), new THREE.Vector3(0, 10, 0))

    const selectedEntryRef = { current: null as CylEntry | null }
    const fastPulseUntil = { current: 0 }

    cityFocusRef.current = (f: Facility) => {
      const entry = cylEntries.find(e => e.facility.properties.name === f.properties.name)
      setSelected(f)
      if (!entry) return
      const sx = entry.cylinder.position.x, sz = entry.cylinder.position.z
      lerpCamera(new THREE.Vector3(sx + 20, 40, sz + 40), new THREE.Vector3(sx, 0, sz))
      selectedEntryRef.current = entry
      fastPulseUntil.current = performance.now() + 3000
    }

    const raycaster = new THREE.Raycaster()
    const mouse = new THREE.Vector2()
    const cylMeshes = cylEntries.map(e => e.cylinder)
    let hoveredEntry: CylEntry | null = null

    const onMouseMove = (e: MouseEvent) => {
      const rect = renderer.domElement.getBoundingClientRect()
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(mouse, camera)
      const hits = raycaster.intersectObjects(cylMeshes)
      if (hits.length > 0) {
        const found = cylEntries.find(ce => ce.cylinder === hits[0].object)
        if (found) {
          hoveredEntry = found; renderer.domElement.style.cursor = 'pointer'
          const proj = found.cylinder.position.clone().project(camera)
          setTooltip({
            x: (proj.x * 0.5 + 0.5) * container.clientWidth,
            y: (-proj.y * 0.5 + 0.5) * container.clientHeight,
            name: found.facility.properties.name,
            score: found.facility.properties.final_score,
          })
        }
      } else {
        hoveredEntry = null; renderer.domElement.style.cursor = 'default'; setTooltip(null)
      }
    }

    const onClick = (e: MouseEvent) => {
      const rect = renderer.domElement.getBoundingClientRect()
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(mouse, camera)
      const hits = raycaster.intersectObjects(cylMeshes)
      if (hits.length > 0) {
        const found = cylEntries.find(ce => ce.cylinder === hits[0].object)
        if (found) setSelected(found.facility)
      }
    }

    renderer.domElement.addEventListener('mousemove', onMouseMove)
    renderer.domElement.addEventListener('click', onClick)

    let rafId: number
    const clock = new THREE.Clock()
    const animate = () => {
      rafId = requestAnimationFrame(animate)
      const t = clock.getElapsedTime()
      gridMat.opacity = 0.08 + 0.05 * Math.sin(t * 0.5)
      for (let vi = 0; vi < lakePosAttr.count; vi++) {
        const vx = lakePosAttr.getX(vi), vy = lakePosAttr.getY(vi)
        lakePosAttr.setZ(vi, Math.sin(t * 0.8 + vx * 0.15) * 0.3 + Math.cos(t * 0.5 + vy * 0.12) * 0.2)
      }
      lakePosAttr.needsUpdate = true; lakeGeo.computeVertexNormals()
      for (const entry of cylEntries) {
        const { cylinder, ring, facility, crown } = entry
        const isHov = entry === hoveredEntry
        const isFast = entry === selectedEntryRef.current && performance.now() < fastPulseUntil.current
        const sp = isFast ? 5.0 : isHov ? 3.0 : 1.5
        const phase = facility.properties.final_score * 0.05
        cylinder.rotation.y = t * 0.3
        const targetSY = isHov ? 1.4 : 1.0
        cylinder.scale.y += (targetSY - cylinder.scale.y) * 0.1
        const isTop1 = facility.properties.rank === 1
        const baseH = isTop1 ? 5 : 4
        cylinder.position.y = baseH * cylinder.scale.y
        if (crown) crown.position.y = (isTop1 ? 10 : 8) * cylinder.scale.y + 1.0
        const pf = Math.abs(Math.sin(t * sp + phase))
        ring.scale.setScalar(1.0 + 0.7 * pf)
        ;(ring.material as THREE.MeshBasicMaterial).opacity = 0.6 * (1 - 0.55 * pf)
      }
      controls.update(); renderer.render(scene, camera)
    }
    animate()

    const onResize = () => {
      camera.aspect = container.clientWidth / container.clientHeight
      camera.updateProjectionMatrix()
      renderer.setSize(container.clientWidth, container.clientHeight)
    }
    window.addEventListener('resize', onResize)

    return () => {
      cancelAnimationFrame(rafId)
      renderer.domElement.removeEventListener('mousemove', onMouseMove)
      renderer.domElement.removeEventListener('click', onClick)
      window.removeEventListener('resize', onResize)
      cityFocusRef.current = null; cityResetRef.current = null
      controls.dispose(); renderer.dispose()
      if (container.contains(renderer.domElement)) container.removeChild(renderer.domElement)
      setTooltip(null)
    }
  }, [viewMode, allFeatures, minScore, setSelected, setTooltip])

  console.log('topFacilities:', topFacilities.length)

  // ── Coverage status (read-only — never touches final_score) ──
  const getCoverageStatus = (facilityId: string): 'uncovered' | 'partial' | 'covered' => {
    const count = derCoverage[facilityId] ?? 0
    if (count === 0) return 'uncovered'
    if (count <= 2) return 'partial'
    return 'covered'
  }

  // ── Candidate card (shared desktop/mobile) ──────────────────
  const renderCandidateCard = (f: Facility, i: number) => {
    const isoHours = facilityIslandHours[f.properties.name]
    const isoColor = isoHours !== undefined
      ? (isoHours < 4 ? '#ef4444' : isoHours < 24 ? '#f97316' : '#22c55e')
      : undefined
    const covStatus = getCoverageStatus(f.properties.name)
    return (
      <div
        key={i}
        className="mg-card"
        onClick={() => {
          if (viewMode === 'map') { setSelected(f); flyTo(f) }
          else { cityFocusRef.current?.(f) }
        }}
        style={{
          background: selected?.properties.name === f.properties.name
            ? 'rgba(255,255,255,0.16)'
            : 'rgba(255,255,255,0.06)',
          backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
          borderRadius: '14px', padding: '10px 12px', marginBottom: '6px',
          border: selected?.properties.name === f.properties.name
            ? '1px solid rgba(255,255,255,0.32)'
            : '1px solid rgba(255,255,255,0.10)',
          borderLeft: `3px solid ${getScoreColor(f.properties.final_score)}`,
          cursor: 'pointer',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div style={{ fontSize: '12px', fontWeight: 600, flex: 1, paddingRight: '8px', lineHeight: 1.35, color: 'white' }}>
            <span style={{ color: 'rgba(255,255,255,0.32)', fontSize: '11px' }}>#{i + 1}{' '}</span>
            {f.properties.name}
          </div>
          <div style={{ fontSize: '14px', fontWeight: 700, color: getScoreColor(f.properties.final_score), flexShrink: 0 }}>
            {f.properties.final_score}
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginTop: '3px' }}>
          <div>
            <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.32)' }}>{f.properties.city}</div>
            {covStatus !== 'uncovered' && (
              <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.45)', marginTop: '2px' }}>
                {covStatus === 'partial' ? '🟡 Partial Coverage' : '🟢 Covered'}
              </div>
            )}
          </div>
          {isoHours !== undefined && (
            <div style={{ fontSize: '10px', color: isoColor, fontWeight: 600 }}>
              ⚡ {isoHours.toFixed(1)}h island
            </div>
          )}
        </div>
      </div>
    )
  }

  // ── Detail panel content ─────────────────────────────────────
  const renderDetailContent = () => {
    if (!selected) return null
    const effectiveScore = selected.properties.final_score

    const nearbyRenewables = renewableInstalls.filter(ri =>
      haversineKm(
        selected.geometry.coordinates[1], selected.geometry.coordinates[0],
        ri.lat, ri.lng
      ) <= 2
    )

    return (
      <>
        <GlassTopHighlight />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.38)', letterSpacing: '0.08em', textShadow: '0 1px 2px rgba(0,0,0,0.5)' }}>FACILITY DETAILS</span>
          <button
            className="mg-close-btn"
            onClick={() => { setSelected(null); popup.current?.remove() }}
            style={{
              background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.16)',
              backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
              color: 'rgba(255,255,255,0.72)', cursor: 'pointer',
              width: '28px', height: '28px', borderRadius: '8px', fontSize: '14px',
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}
          >×</button>
        </div>

        <div style={{
          background: `rgba(${effectiveScore >= 80 ? '239,68,68' : effectiveScore >= 60 ? '249,115,22' : effectiveScore >= 40 ? '234,179,8' : '34,197,94'},0.12)`,
          border: `1px solid ${getScoreColor(effectiveScore)}44`,
          borderRadius: '14px', padding: '16px', marginBottom: '16px',
          boxShadow: `inset 0 1px 0 rgba(255,255,255,0.12), 0 0 24px ${getScoreColor(effectiveScore)}22`,
        }}>
          <div style={{ fontSize: '44px', fontWeight: 700, lineHeight: 1, color: getScoreColor(effectiveScore), textShadow: `0 0 24px ${getScoreColor(effectiveScore)}77` }}>
            {effectiveScore}
            <span style={{ fontSize: '14px', fontWeight: 400, color: 'rgba(255,255,255,0.32)' }}>/100</span>
          </div>
          <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)', marginTop: '4px', textShadow: '0 1px 2px rgba(0,0,0,0.5)' }}>Microgrid Viability Score</div>
          <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.28)', marginTop: '2px', textShadow: '0 1px 2px rgba(0,0,0,0.5)' }}>Rank #{selected.properties.rank} of 906</div>
        </div>

        <div style={{ marginBottom: '16px' }}>
          <div style={{ fontSize: '14px', fontWeight: 600, lineHeight: 1.35, marginBottom: '4px', textShadow: '0 1px 3px rgba(0,0,0,0.5)' }}>{selected.properties.name}</div>
          <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)', textShadow: '0 1px 2px rgba(0,0,0,0.4)' }}>{selected.properties.type}</div>
          <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)', textShadow: '0 1px 2px rgba(0,0,0,0.4)' }}>{selected.properties.city}</div>
        </div>

        <div style={{ marginBottom: '16px' }}>
          <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.32)', letterSpacing: '0.08em', marginBottom: '10px', textShadow: '0 1px 2px rgba(0,0,0,0.5)' }}>SCORE BREAKDOWN</div>
          <ScoreBar value={selected.properties.outage_risk_score} label="Outage Risk" />
          <ScoreBar value={selected.properties.solar_potential_score} label="Solar Potential" />
          {/* Task 3 — kWh/m² */}
          {(selected.properties.solar_kwh_per_m2 ?? 0) > 0 && (
            <div style={{ fontSize: '10px', color: 'rgba(0,200,255,0.7)', marginTop: '-6px', marginBottom: '10px', paddingLeft: '2px' }}>
              ~{selected.properties.solar_kwh_per_m2} kWh/m² annually
            </div>
          )}
          <ScoreBar value={selected.properties.facility_score} label="Facility Criticality" />
        </div>

        {/* Task 2 — Reliability Forecast */}
        {nearbyRenewables.length > 0 && (
          <div style={{
            background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.10)',
            borderRadius: '12px', padding: '12px', marginBottom: '16px',
          }}>
            <button
              onClick={() => setReliabilityOpen(v => !v)}
              style={{
                background: 'none', border: 'none', color: 'rgba(255,255,255,0.72)',
                cursor: 'pointer', fontSize: '11px', fontWeight: 600, padding: 0,
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                width: '100%', fontFamily: 'inherit', letterSpacing: '0.06em',
              }}
            >
              <span>RELIABILITY FORECAST</span>
              <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.35)' }}>{reliabilityOpen ? '▲' : '▼'}</span>
            </button>
            {reliabilityOpen && (
              <div style={{ marginTop: '12px' }}>
                <ReliabilityChart
                  startScore={effectiveScore}
                  installType={nearbyRenewables[0].installType}
                />
                <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.3)', marginTop: '6px' }}>
                  {nearbyRenewables.length} renewable installation(s) within 2km
                </div>
              </div>
            )}
          </div>
        )}

        <div style={{
          background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.10)',
          backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
          borderRadius: '12px', padding: '12px', fontSize: '12px',
          color: 'rgba(255,255,255,0.72)', lineHeight: 1.6,
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08)', textShadow: '0 1px 2px rgba(0,0,0,0.4)',
          marginBottom: '16px',
        }}>
          <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.32)', letterSpacing: '0.08em', marginBottom: '6px' }}>RECOMMENDATION</div>
          {effectiveScore >= 80
            ? '🔴 High Priority — Immediate microgrid investment recommended'
            : effectiveScore >= 60
            ? '🟠 Medium Priority — Plan for near-term deployment'
            : effectiveScore >= 40
            ? '🟡 Moderate — Assess feasibility within 2 years'
            : '🟢 Lower Priority — Reassess annually'}
        </div>

        {/* Task 5 — Island Mode */}
        <div style={{
          background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.10)',
          borderRadius: '12px', padding: '12px', marginBottom: '16px',
        }}>
          <button
            onClick={runIslandMode}
            style={{
              width: '100%', padding: '10px', cursor: 'pointer',
              background: 'rgba(20,184,166,0.2)', border: '1px solid rgba(20,184,166,0.4)',
              borderRadius: '10px', color: 'rgba(255,255,255,0.9)',
              fontSize: '12px', fontWeight: 600, fontFamily: 'inherit',
              transition: 'background 200ms ease',
            }}
          >
            ⚡ Run Island Mode Simulation
          </button>

          {islandResult && (
            <div style={{ marginTop: '12px', overflow: 'hidden', flexShrink: 0 }}>
              <div style={{
                padding: '10px 12px', borderRadius: '10px',
                background: `${islandResult.color}18`,
                border: `1px solid ${islandResult.color}44`,
                marginBottom: '10px',
              }}>
                <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.85)', lineHeight: 1.5 }}>
                  This facility could survive approximately{' '}
                  <span style={{ color: islandResult.color, fontWeight: 700, fontSize: '15px' }}>
                    {islandResult.hours}h
                  </span>{' '}
                  in island mode
                </div>
                <div style={{
                  display: 'inline-block', marginTop: '6px', padding: '2px 8px',
                  borderRadius: '100px', background: `${islandResult.color}33`,
                  color: islandResult.color, fontSize: '10px', fontWeight: 600, letterSpacing: '0.05em',
                }}>
                  {islandResult.label}
                </div>
              </div>

              <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.38)', marginBottom: '6px', letterSpacing: '0.05em' }}>
                SIMULATE DURATION
              </div>
              <input
                type="range" min={1} max={72} value={islandHours}
                onChange={e => setIslandHours(Number(e.target.value))}
                style={{ width: '100%', cursor: 'pointer', margin: '0 0 6px', display: 'block' }}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', marginBottom: '8px' }}>
                <span style={{ color: 'rgba(255,255,255,0.3)' }}>1h</span>
                <span style={{ color: 'rgba(255,255,255,0.7)', fontWeight: 600 }}>{islandHours}h</span>
                <span style={{ color: 'rgba(255,255,255,0.3)' }}>72h</span>
              </div>
              <div style={{
                fontSize: '11px', padding: '6px 10px', borderRadius: '8px',
                background: islandHours <= islandResult.hours
                  ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)',
                color: islandHours <= islandResult.hours
                  ? '#22c55e' : '#ef4444',
                border: `1px solid ${islandHours <= islandResult.hours ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`,
              }}>
                {islandHours <= islandResult.hours
                  ? `✓ Resources sufficient at ${islandHours}h`
                  : `✗ Resources depleted after ~${Math.floor(islandResult.hours)}h`}
              </div>
            </div>
          )}
        </div>
      </>
    )
  }

  // ── JSX ──────────────────────────────────────────────────────
  return (
    <div style={{ width: '100vw', height: '100dvh', fontFamily: "'Inter','Segoe UI',sans-serif", position: 'relative', overflow: 'hidden' }}>

      <style>{`
        .mg-popup .mapboxgl-popup-content { background: rgba(255,255,255,0.10) !important; backdrop-filter: blur(60px) saturate(200%) !important; -webkit-backdrop-filter: blur(60px) saturate(200%) !important; border: 1px solid rgba(255,255,255,0.22) !important; border-radius: 18px !important; padding: 0 !important; box-shadow: 0 8px 32px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.2), inset 0 0 20px rgba(255,255,255,0.05) !important; }
        .mg-popup .mapboxgl-popup-tip { display: none !important; }
        .mg-popup-inner  { padding: 14px 18px; }
        .mg-popup-name   { font-size: 13px; font-weight: 600; color: rgba(255,255,255,0.95); margin-bottom: 2px; text-shadow: 0 1px 3px rgba(0,0,0,0.6); }
        .mg-popup-city   { font-size: 11px; color: rgba(255,255,255,0.4); margin-bottom: 8px; }
        .mg-popup-score  { font-size: 26px; font-weight: 700; line-height: 1; text-shadow: 0 2px 8px rgba(0,0,0,0.5); }
        .mg-popup-denom  { font-size: 12px; color: rgba(255,255,255,0.3); font-weight: 400; }
        .mg-popup-rank   { font-size: 10px; color: rgba(255,255,255,0.28); margin-top: 3px; }
        .mg-card { transition: transform 300ms ease, box-shadow 300ms ease, background 200ms ease; cursor: pointer; }
        .mg-card:hover { transform: translateY(-2px); box-shadow: 0 14px 40px rgba(0,0,0,0.55), 0 4px 14px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.25) !important; }
        .mg-close-btn { transition: background 200ms ease; }
        .mg-close-btn:hover { background: rgba(255,255,255,0.16) !important; }
        .mg-collapse-btn { transition: background 200ms ease, transform 300ms ease; }
        .mg-collapse-btn:hover { background: rgba(255,255,255,0.2) !important; }
        .mg-reset-btn { transition: background 200ms ease, box-shadow 200ms ease; }
        .mg-reset-btn:hover { background: rgba(255,255,255,0.18) !important; box-shadow: 0 8px 24px rgba(0,0,0,0.5) !important; }
        .mg-toggle-btn { background: transparent; border: none; color: rgba(255,255,255,0.5); font-size: 13px; font-weight: 500; padding: 8px 18px; cursor: pointer; border-radius: 100px; transition: all 200ms ease; white-space: nowrap; font-family: inherit; min-height: 44px; min-width: 44px; }
        .mg-toggle-btn.active { background: rgba(37,99,235,0.75); color: white; box-shadow: 0 0 16px rgba(37,99,235,0.5), inset 0 1px 0 rgba(255,255,255,0.25); }
        .mg-toggle-btn:hover:not(.active) { background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.85); }
        @keyframes pulse-dot { 0%, 100% { opacity: 1; box-shadow: 0 0 6px #ef4444; } 50% { opacity: 0.35; box-shadow: 0 0 2px #ef4444; } }
        .mg-pulse-dot { width: 7px; height: 7px; border-radius: 50%; background: #ef4444; animation: pulse-dot 1.8s ease-in-out infinite; flex-shrink: 0; }
        .mg-outage-btn { transition: background 200ms ease, box-shadow 200ms ease; }
        .mg-outage-btn:hover { background: rgba(255,255,255,0.18) !important; box-shadow: 0 8px 24px rgba(0,0,0,0.5) !important; }
        .mg-drawer { transition: height 300ms cubic-bezier(0.32, 0.72, 0, 1); }
        .mg-bottom-sheet { transition: transform 300ms cubic-bezier(0.32, 0.72, 0, 1); }
        .mg-der-drag { cursor: grab; user-select: none; transition: transform 150ms ease, box-shadow 150ms ease; }
        .mg-der-drag:hover { transform: scale(1.08); }
        .mg-der-drag:active { cursor: grabbing; transform: scale(0.96); }
        @keyframes toast-in { from { opacity:0; transform:translateX(-50%) translateY(10px); } to { opacity:1; transform:translateX(-50%) translateY(0); } }
        .mg-toast { animation: toast-in 300ms ease; }
      `}</style>

      {/* Mapbox — always in DOM */}
      <div
        ref={mapContainer}
        onDragOver={e => e.preventDefault()}
        onDrop={handleMapDrop}
        style={{
          position: 'absolute', inset: 0, width: '100%', height: '100dvh',
          opacity: viewMode === 'map' ? 1 : 0,
          pointerEvents: viewMode === 'map' ? 'auto' : 'none',
          transition: 'opacity 400ms ease', zIndex: viewMode === 'map' ? 1 : 0,
        }}
      />

      {/* Three.js canvas */}
      <div ref={cityContainer} style={{
        position: 'absolute', inset: 0, background: '#0a0f1e',
        opacity: viewMode === 'city' ? 1 : 0,
        pointerEvents: viewMode === 'city' ? 'auto' : 'none',
        transition: 'opacity 400ms ease', zIndex: viewMode === 'city' ? 1 : 0,
      }} />

      {/* View toggle */}
      <div style={{
        position: 'absolute', top: '20px', left: '50%', transform: 'translateX(-50%)',
        ...glass, borderRadius: '100px', padding: '4px',
        display: 'flex', alignItems: 'center', gap: '2px', zIndex: 20,
      }}>
        <GlassTopHighlight />
        <button className={`mg-toggle-btn${viewMode === 'map' ? ' active' : ''}`} onClick={() => setViewMode('map')}>Map View</button>
        <button className={`mg-toggle-btn${viewMode === 'city' ? ' active' : ''}`} onClick={() => setViewMode('city')}>City Model</button>
      </div>

      {/* Combined DER + Outage panel — desktop map view only, bottom-right, horizontal */}
      {viewMode === 'map' && !isMobile && (
        <div style={{
          position: 'fixed',
          bottom: '32px', right: '24px',
          left: 'unset',
          zIndex: 25,
          background: 'rgba(255,255,255,0.08)',
          backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
          border: '1px solid rgba(255,255,255,0.15)',
          borderRadius: '16px',
          padding: '10px 16px',
          paddingBottom: 'max(12px, env(safe-area-inset-bottom))',
          display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '16px',
        }}>
          {/* DER section */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
            <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.4)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
              DER
            </div>
            <div
              className="mg-der-drag"
              draggable
              onDragStart={e => e.dataTransfer.setData('text/plain', 'ev-charger')}
              style={{
                background: 'rgba(255,255,255,0.08)',
                backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
                border: '1px solid rgba(255,255,255,0.15)',
                borderRadius: '12px',
                width: '44px', height: '44px',
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '2px',
              }}
            >
              <span style={{ fontSize: '20px' }}>⚡</span>
              <span style={{ fontSize: '8px', color: 'rgba(255,255,255,0.55)', letterSpacing: '0.04em' }}>EV</span>
            </div>
          </div>

          {/* Vertical divider */}
          <div style={{ width: '1px', height: '40px', background: 'rgba(255,255,255,0.15)', flexShrink: 0 }} />

          {/* Outages section */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
            <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.4)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
              OUTAGES
            </div>
            <div
              onClick={() => setOutageVisible(v => !v)}
              style={{
                width: '40px', height: '24px',
                borderRadius: '12px',
                background: outageVisible ? '#f97316' : 'rgba(255,255,255,0.2)',
                position: 'relative',
                cursor: 'pointer',
                transition: 'background 0.2s ease',
                flexShrink: 0,
              }}
            >
              <div style={{
                position: 'absolute',
                top: '2px',
                left: outageVisible ? '18px' : '2px',
                width: '20px', height: '20px',
                borderRadius: '50%',
                background: 'white',
                transition: 'left 0.2s ease',
                boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
              }} />
            </div>
          </div>
        </div>
      )}

      {/* Task 1 — Score Preview banner */}
      {placedChargers.length > 0 && !derConfirmed && viewMode === 'map' && (
        <div style={{
          position: 'absolute',
          bottom: isMobile ? '140px' : '82px',
          left: '50%', transform: 'translateX(-50%)',
          ...glass, borderRadius: '12px', padding: '10px 16px',
          zIndex: 16, display: 'flex', alignItems: 'center', gap: '12px',
          background: 'rgba(234,179,8,0.10)',
          border: '1px solid rgba(234,179,8,0.35)',
          whiteSpace: 'nowrap',
        }}>
          <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.85)' }}>
            ⚡ {placedChargers.length} microgrid(s) placed — confirm to apply coverage status to nearby facilities
          </span>
          <button
            onClick={confirmDERPlacement}
            style={{
              background: 'rgba(234,179,8,0.25)', border: '1px solid rgba(234,179,8,0.5)',
              borderRadius: '8px', color: '#fde047', cursor: 'pointer',
              fontSize: '11px', fontWeight: 600, padding: '5px 12px', fontFamily: 'inherit',
              transition: 'background 200ms ease',
            }}
          >
            Confirm DER Placement
          </button>
          <button
            onClick={() => {
              Object.values(placedMarkerRefs.current).forEach(m => m.remove())
              placedMarkerRefs.current = {}
              setPlacedChargers([])
              setDerConfirmed(false)
              setDerCoverage({})
              setTimeout(() => map.current?.resize(), 50)
            }}
            style={{
              background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.2)',
              borderRadius: '8px', color: 'rgba(255,255,255,0.6)', cursor: 'pointer',
              fontSize: '14px', fontWeight: 400, padding: '5px 10px', fontFamily: 'inherit',
              lineHeight: 1, transition: 'background 200ms ease',
            }}
            title="Cancel placement"
          >×</button>
        </div>
      )}


      {/* Reset View — city mode */}
      {viewMode === 'city' && (
        <button
          className="mg-reset-btn"
          onClick={() => cityResetRef.current?.()}
          style={{
            position: 'absolute',
            bottom: isMobile ? '96px' : '80px', right: isMobile ? '16px' : '20px',
            ...glass, borderRadius: '100px', padding: '9px 20px', border: 'none',
            color: 'rgba(255,255,255,0.8)', cursor: 'pointer',
            fontSize: '12px', fontWeight: 500, fontFamily: "'Inter','Segoe UI',sans-serif",
            zIndex: 20, letterSpacing: '0.04em', minHeight: '44px',
          }}
        >
          Reset View
        </button>
      )}

      {/* Desktop sidebar */}
      {!isMobile && (
        <div style={{
          position: 'absolute', top: '20px', left: '20px',
          width: '380px',
          maxHeight: 'calc(100dvh - 40px)',
          zIndex: 10,
          display: sidebarCollapsed ? 'none' : undefined,
        }}>
          {/* Glass panel */}
          <div style={{
            position: 'relative',
            ...glass,
            overflowY: 'auto',
            overflowX: 'hidden',
            padding: '20px 16px',
            maxHeight: 'calc(100dvh - 40px)',
          }}>
            <GlassTopHighlight />

            {/* Title + subtitle + outage status */}
            <div style={{ marginBottom: '18px' }}>
              <h2 style={{
                margin: '0 0 4px', fontSize: '18px', fontWeight: 700,
                background: 'linear-gradient(100deg, #60a5fa 0%, #06b6d4 100%)',
                WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
              }}>GridIQ</h2>
              <p style={{ margin: '0 0 8px', fontSize: '11px', color: 'rgba(255,255,255,0.32)', textShadow: '0 1px 2px rgba(0,0,0,0.5)' }}>GTA Critical Facilities</p>
              {outageStatus === 'ok' ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <div style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#f97316', flexShrink: 0 }} />
                  <span style={{ fontSize: '10px', color: 'rgba(249,115,22,0.9)', letterSpacing: '0.05em', textShadow: '0 1px 2px rgba(0,0,0,0.5)' }}>{outageData?.features?.length ?? 0} Active Outages</span>
                </div>
              ) : outageStatus === 'no-outages' ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <div style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#22c55e', flexShrink: 0 }} />
                  <span style={{ fontSize: '10px', color: 'rgba(34,197,94,0.85)', letterSpacing: '0.05em', textShadow: '0 1px 2px rgba(0,0,0,0.5)' }}>No Active Outages</span>
                </div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <div style={{ width: '7px', height: '7px', borderRadius: '50%', background: 'rgba(255,255,255,0.2)', flexShrink: 0 }} />
                  <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.22)', letterSpacing: '0.05em' }}>Outage Data Unavailable</span>
                </div>
              )}
            </div>

            {/* Score filter */}
            <div style={{
              position: 'relative', background: 'rgba(255,255,255,0.06)',
              backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
              border: '1px solid rgba(255,255,255,0.14)', borderRadius: '14px',
              padding: '12px', marginBottom: '12px',
              boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.12)',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', marginBottom: '10px', letterSpacing: '0.06em' }}>
                <span style={{ color: 'rgba(255,255,255,0.38)', textShadow: '0 1px 2px rgba(0,0,0,0.5)' }}>MIN SCORE FILTER</span>
                <span style={{ color: 'rgba(255,255,255,0.92)', fontWeight: 700, textShadow: '0 0 14px rgba(255,255,255,0.25)' }}>{minScore}+</span>
              </div>
              <input
                type="range" min={0} max={90} step={5} value={minScore}
                onChange={e => setMinScore(Number(e.target.value))}
                style={{ width: '100%', cursor: 'pointer', margin: 0, display: 'block' }}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: 'rgba(255,255,255,0.2)', marginTop: '6px' }}>
                <span>All</span><span>90+</span>
              </div>
            </div>

            {/* Utility Lines toggle */}
            <div style={{
              background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.10)',
              borderRadius: '10px', padding: '8px 12px', marginBottom: '18px',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
              <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.6)' }}>Utility Lines</span>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={utilityLinesVisible}
                  onChange={e => setUtilityLinesVisible(e.target.checked)}
                  style={{ cursor: 'pointer', accentColor: 'rgba(0,200,255,0.8)', width: '14px', height: '14px' }}
                />
                <span style={{ fontSize: '10px', color: utilityLinesVisible ? 'rgba(0,200,255,0.8)' : 'rgba(255,255,255,0.3)' }}>
                  {utilityLinesVisible ? 'Visible' : 'Hidden'}
                </span>
              </label>
            </div>

            {/* Candidates section */}
            <div>
              <div style={{ display: 'flex', gap: '6px', marginBottom: '10px' }}>
                {(['all', 'uncovered', 'covered'] as const).map(pill => (
                  <button
                    key={pill}
                    onClick={() => setCoverageFilter(pill)}
                    style={{
                      padding: '4px 10px', borderRadius: '100px', fontSize: '10px',
                      fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit',
                      border: coverageFilter === pill ? '1px solid #f97316' : '1px solid rgba(255,255,255,0.15)',
                      background: coverageFilter === pill ? 'rgba(249,115,22,0.3)' : 'rgba(255,255,255,0.06)',
                      color: 'white', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
                    }}
                  >
                    {pill === 'all' ? 'All' : pill === 'uncovered' ? 'Uncovered' : 'Covered'}
                  </button>
                ))}
              </div>
              <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.32)', letterSpacing: '0.08em', marginBottom: '10px', textShadow: '0 1px 2px rgba(0,0,0,0.5)' }}>
                TOP 10 CANDIDATES
              </div>
              {nrelStations.length > 0 && (
                <div style={{ fontSize: '9px', color: 'rgba(0,200,255,0.5)', marginBottom: '8px', letterSpacing: '0.04em' }}>
                  ⚡ Survival hours include existing NREL charger data
                </div>
              )}
              {topFacilities
                .map((f, i) => ({ f, i }))
                .filter(({ f }) => {
                  if (coverageFilter === 'all') return true
                  const status = getCoverageStatus(f.properties.name)
                  if (coverageFilter === 'uncovered') return status === 'uncovered'
                  return status === 'partial' || status === 'covered'
                })
                .map(({ f, i }) => renderCandidateCard(f, i))}
            </div>
          </div>

          {/* Chevron — visible state, at right edge of sidebar */}
          <button
            className="mg-collapse-btn"
            onClick={() => setSidebarCollapsed(true)}
            style={{
              position: 'absolute', right: '-16px', top: '50%',
              transform: 'translateY(-50%)',
              width: '32px', height: '32px',
              background: 'rgba(255,255,255,0.08)',
              backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
              border: '1px solid rgba(255,255,255,0.15)', borderRadius: '50%',
              color: 'rgba(255,255,255,0.85)', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '14px', lineHeight: 1, zIndex: 2,
            }}
          >‹</button>
        </div>
      )}

      {/* Chevron — collapsed state, fixed at left edge of map */}
      {!isMobile && sidebarCollapsed && (
        <button
          className="mg-collapse-btn"
          onClick={() => setSidebarCollapsed(false)}
          style={{
            position: 'fixed', left: '8px', top: '50%',
            transform: 'translateY(-50%)',
            width: '32px', height: '32px',
            background: 'rgba(255,255,255,0.08)',
            backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
            border: '1px solid rgba(255,255,255,0.15)', borderRadius: '50%',
            color: 'rgba(255,255,255,0.85)', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '14px', lineHeight: 1, zIndex: 20,
          }}
        >›</button>
      )}

      {/* Mobile bottom drawer */}
      {isMobile && (
        <div
          className="mg-drawer"
          style={{
            position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 30,
            ...glass, borderRadius: '20px 20px 0 0',
            height: drawerExpanded ? '60dvh' : '80px',
            overflow: 'hidden', display: 'flex', flexDirection: 'column',
          }}
        >
          <div
            onClick={toggleDrawer}
            style={{
              cursor: 'pointer', padding: '10px 16px 8px', flexShrink: 0,
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px', minHeight: '44px',
            }}
          >
            <div style={{ width: '36px', height: '4px', borderRadius: '2px', background: 'rgba(255,255,255,0.35)', flexShrink: 0 }} />
            <div style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <h2 style={{
                margin: 0, fontSize: '14px', fontWeight: 700,
                background: 'linear-gradient(100deg, #60a5fa 0%, #06b6d4 100%)',
                WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
              }}>GridIQ</h2>
              {outageStatus === 'ok' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#f97316', flexShrink: 0 }} />
                  <span style={{ fontSize: '9px', color: 'rgba(249,115,22,0.9)', letterSpacing: '0.05em' }}>{outageData?.features?.length ?? 0} OUTAGES</span>
                </div>
              )}
            </div>
          </div>

          {!drawerExpanded && (
            <div style={{ padding: '0 16px 8px', flexShrink: 0 }}>
              {topFacilities.slice(0, 2).map((f, i) => (
                <div
                  key={i}
                  onClick={() => { if (viewMode === 'map') { setSelected(f); flyTo(f) } else { cityFocusRef.current?.(f) } }}
                  style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '3px 0',
                    borderTop: i === 0 ? '1px solid rgba(255,255,255,0.08)' : undefined,
                    cursor: 'pointer',
                  }}
                >
                  <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.7)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginRight: '8px' }}>
                    <span style={{ color: 'rgba(255,255,255,0.3)' }}>#{f.properties.rank}</span>{' '}{f.properties.name}
                  </span>
                  <span style={{ fontSize: '12px', fontWeight: 700, color: getScoreColor(f.properties.final_score), flexShrink: 0 }}>
                    {f.properties.final_score}
                  </span>
                </div>
              ))}
            </div>
          )}

          {drawerExpanded && (
            <div style={{ flex: 1, overflowY: 'auto', padding: '8px 16px', paddingBottom: 'calc(40px + env(safe-area-inset-bottom))' }}>
              <div style={{
                position: 'relative', background: 'rgba(255,255,255,0.06)',
                backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
                border: '1px solid rgba(255,255,255,0.14)', borderRadius: '14px',
                padding: '12px', marginBottom: '12px',
                boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.12)',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', marginBottom: '10px', letterSpacing: '0.06em' }}>
                  <span style={{ color: 'rgba(255,255,255,0.38)' }}>MIN SCORE FILTER</span>
                  <span style={{ color: 'rgba(255,255,255,0.92)', fontWeight: 700 }}>{minScore}+</span>
                </div>
                <input
                  type="range" min={0} max={90} step={5} value={minScore}
                  onChange={e => setMinScore(Number(e.target.value))}
                  style={{ width: '100%', cursor: 'pointer', margin: 0, display: 'block' }}
                />
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: 'rgba(255,255,255,0.2)', marginTop: '6px' }}>
                  <span>All</span><span>90+</span>
                </div>
              </div>

              {/* Task 4 mobile toggle */}
              <div style={{
                background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.10)',
                borderRadius: '10px', padding: '8px 12px', marginBottom: '16px',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              }}>
                <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.6)' }}>Utility Lines</span>
                <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={utilityLinesVisible}
                    onChange={e => setUtilityLinesVisible(e.target.checked)}
                    style={{ cursor: 'pointer', accentColor: 'rgba(0,200,255,0.8)', width: '14px', height: '14px' }}
                  />
                  <span style={{ fontSize: '10px', color: utilityLinesVisible ? 'rgba(0,200,255,0.8)' : 'rgba(255,255,255,0.3)' }}>
                    {utilityLinesVisible ? 'Visible' : 'Hidden'}
                  </span>
                </label>
              </div>

              <div style={{ display: 'flex', gap: '6px', marginBottom: '10px' }}>
                {(['all', 'uncovered', 'covered'] as const).map(pill => (
                  <button
                    key={pill}
                    onClick={() => setCoverageFilter(pill)}
                    style={{
                      padding: '4px 10px', borderRadius: '100px', fontSize: '10px',
                      fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit',
                      border: coverageFilter === pill ? '1px solid #f97316' : '1px solid rgba(255,255,255,0.15)',
                      background: coverageFilter === pill ? 'rgba(249,115,22,0.3)' : 'rgba(255,255,255,0.06)',
                      color: 'white', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
                    }}
                  >
                    {pill === 'all' ? 'All' : pill === 'uncovered' ? 'Uncovered' : 'Covered'}
                  </button>
                ))}
              </div>
              <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.32)', letterSpacing: '0.08em', marginBottom: '10px' }}>
                TOP 10 CANDIDATES
              </div>
              {topFacilities
                .map((f, i) => ({ f, i }))
                .filter(({ f }) => {
                  if (coverageFilter === 'all') return true
                  const status = getCoverageStatus(f.properties.name)
                  if (coverageFilter === 'uncovered') return status === 'uncovered'
                  return status === 'partial' || status === 'covered'
                })
                .map(({ f, i }) => renderCandidateCard(f, i))}
            </div>
          )}
        </div>
      )}

      {/* Priority legend */}
      <div style={{
        position: 'fixed',
        bottom: isMobile ? '88px' : '32px',
        left: '50%', transform: 'translateX(-50%)',
        background: 'rgba(255,255,255,0.08)',
        backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
        border: '1px solid rgba(255,255,255,0.15)',
        borderRadius: '16px',
        padding: '12px 20px',
        paddingBottom: 'max(12px, env(safe-area-inset-bottom))',
        color: 'white',
        display: 'flex', alignItems: 'center', gap: '20px',
        zIndex: isMobile ? 15 : 20,
        fontSize: '11px', pointerEvents: 'none', whiteSpace: 'nowrap',
        transition: 'bottom 300ms cubic-bezier(0.32, 0.72, 0, 1)',
      }}>
        <span style={{ color: 'rgba(255,255,255,0.32)', fontSize: '10px', letterSpacing: '0.07em', textShadow: '0 1px 2px rgba(0,0,0,0.5)' }}>PRIORITY</span>
        {[
          { color: '#22c55e', label: 'Low <40' },
          { color: '#eab308', label: '40–60' },
          { color: '#f97316', label: '60–80' },
          { color: '#ef4444', label: 'Critical >80' },
        ].map(({ color, label }) => (
          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <div style={{ width: '9px', height: '9px', borderRadius: '50%', background: color, boxShadow: `0 0 8px ${color}`, flexShrink: 0 }} />
            <span style={{ color: 'rgba(255,255,255,0.58)', textShadow: '0 1px 2px rgba(0,0,0,0.5)' }}>{label}</span>
          </div>
        ))}
      </div>

      {/* Desktop detail panel */}
      {selected && !isMobile && (
        <div style={{
          position: 'fixed', top: '16px', right: '24px', bottom: 'unset', width: '280px',
          maxHeight: 'calc(100dvh - 146px)', ...glass,
          overflowY: 'auto', overflowX: 'hidden', padding: '20px 16px', zIndex: 10,
        }}>
          {renderDetailContent()}
        </div>
      )}

      {/* Mobile detail sheet */}
      {selected && isMobile && (
        <div
          className="mg-bottom-sheet"
          style={{
            position: 'fixed', bottom: 0, left: 0, right: 0, maxHeight: 'calc(70dvh - env(safe-area-inset-bottom))',
            zIndex: 40, ...glass, borderRadius: '20px 20px 0 0',
            overflowY: 'auto', padding: '20px 16px', paddingBottom: 'calc(80px + env(safe-area-inset-bottom))', transform: 'translateY(0)',
          }}
        >
          {renderDetailContent()}
        </div>
      )}

      {/* City model hover tooltip */}
      {tooltip && viewMode === 'city' && (
        <div style={{
          position: 'absolute', left: tooltip.x + 14, top: tooltip.y - 36,
          background: 'rgba(10,15,30,0.92)', border: `1px solid ${getScoreColor(tooltip.score)}55`,
          borderRadius: '10px', padding: '8px 13px', color: 'white', fontSize: '12px',
          pointerEvents: 'none', zIndex: 30, backdropFilter: 'blur(12px)',
          boxShadow: `0 4px 20px rgba(0,0,0,0.6), 0 0 12px ${getScoreColor(tooltip.score)}33`,
        }}>
          <div style={{ fontWeight: 600, marginBottom: '3px', maxWidth: '200px', lineHeight: 1.3 }}>{tooltip.name}</div>
          <div style={{ color: getScoreColor(tooltip.score), fontWeight: 700, fontSize: '13px' }}>
            {tooltip.score}<span style={{ color: 'rgba(255,255,255,0.35)', fontWeight: 400, fontSize: '10px' }}>/100</span>
          </div>
        </div>
      )}

      {/* Task 1 — Toast notification */}
      {toast && (
        <div
          className="mg-toast"
          style={{
            position: 'fixed', bottom: isMobile ? '180px' : '90px',
            left: '50%', transform: 'translateX(-50%)',
            ...glass, borderRadius: '100px', padding: '10px 20px',
            fontSize: '12px', fontWeight: 500, zIndex: 50,
            background: 'rgba(20,184,166,0.2)', border: '1px solid rgba(20,184,166,0.4)',
            color: 'rgba(255,255,255,0.9)', whiteSpace: 'nowrap',
            pointerEvents: 'none',
          }}
        >
          ✓ {toast}
        </div>
      )}
    </div>
  )
}
