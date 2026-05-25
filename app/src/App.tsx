import { useEffect, useRef, useState, useCallback } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import './App.css'

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN

interface FacilityProperties {
  name: string
  type: string
  city: string
  address: string
  outage_risk_score: number
  solar_potential_score: number
  facility_score: number
  final_score: number
  rank: number
}

interface Facility {
  properties: FacilityProperties
  geometry: { coordinates: [number, number] }
}

function getScoreColor(score: number): string {
  if (score >= 80) return '#ef4444'
  if (score >= 60) return '#f97316'
  if (score >= 40) return '#eab308'
  return '#22c55e'
}

function ScoreBar({ value, label }: { value: number; label: string }) {
  return (
    <div style={{ marginBottom: '10px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', marginBottom: '4px' }}>
        <span style={{ color: '#64748b' }}>{label}</span>
        <span style={{ color: '#e2e8f0' }}>{(value * 100).toFixed(0)}%</span>
      </div>
      <div style={{ background: 'rgba(255,255,255,0.08)', borderRadius: '4px', height: '4px' }}>
        <div style={{
          background: 'linear-gradient(90deg, #2563eb, #06b6d4)',
          width: `${value * 100}%`,
          height: '100%',
          borderRadius: '4px',
        }} />
      </div>
    </div>
  )
}

export default function App() {
  const mapContainer = useRef<HTMLDivElement>(null)
  const map = useRef<mapboxgl.Map | null>(null)
  const popup = useRef<mapboxgl.Popup | null>(null)
  const animRef = useRef<number>(0)

  const [selected, setSelected] = useState<Facility | null>(null)
  const [topFacilities, setTopFacilities] = useState<Facility[]>([])
  const [allFeatures, setAllFeatures] = useState<Facility[]>([])
  const [minScore, setMinScore] = useState(0)
  const [mapLoaded, setMapLoaded] = useState(false)

  // ── Fly to facility + show popup ─────────────────────────────────────────
  const flyTo = useCallback((f: Facility) => {
    if (!map.current) return
    map.current.flyTo({
      center: f.geometry.coordinates,
      zoom: 15,
      pitch: 60,
      bearing: -20,
      duration: 1600,
      essential: true,
    })

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

  // ── Pulse animation (opacity oscillation for high-score ring layer) ──────
  useEffect(() => {
    if (!mapLoaded) return
    let t0: number | null = null
    const tick = (ts: number) => {
      if (!t0) t0 = ts
      const opacity = 0.1 + 0.22 * Math.abs(Math.sin(((ts - t0) / 1000) * 1.3))
      if (map.current?.getLayer('facilities-pulse')) {
        map.current.setPaintProperty('facilities-pulse', 'circle-opacity', opacity)
      }
      animRef.current = requestAnimationFrame(tick)
    }
    animRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(animRef.current)
  }, [mapLoaded])

  // ── Score filter ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapLoaded || !map.current) return
    const src = map.current.getSource('facilities') as mapboxgl.GeoJSONSource
    if (!src) return
    src.setData({
      type: 'FeatureCollection',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      features: allFeatures.filter(f => f.properties.final_score >= minScore) as any,
    })
  }, [minScore, allFeatures, mapLoaded])

  // ── Map initialisation ───────────────────────────────────────────────────
  useEffect(() => {
    if (map.current || !mapContainer.current) return

    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/dark-v11',
      center: [-79.3832, 43.3],   // start south + zoomed out for fly-in
      zoom: 7.5,
      pitch: 0,
      bearing: 0,
      antialias: true,
      maxBounds: [[-80.8, 43.0], [-78.4, 44.6]],
      minZoom: 7,
      maxZoom: 18,
    })

    map.current.on('load', async () => {
      const m = map.current!

      // Atmosphere / fog effect
      ;(m as any).setFog({
        color: 'rgb(6, 10, 24)',
        'high-color': 'rgb(12, 28, 65)',
        'horizon-blend': 0.06,
        'space-color': 'rgb(3, 6, 18)',
        'star-intensity': 0.75,
      })

      // Load GeoJSON
      const res = await fetch('./facilities.geojson')
      const data = await res.json()
      const sorted = [...data.features].sort(
        (a: Facility, b: Facility) => b.properties.final_score - a.properties.final_score
      )
      setTopFacilities(sorted.slice(0, 10))
      setAllFeatures(data.features)

      m.addSource('facilities', { type: 'geojson', data })

      // ── 3D buildings with blue/teal height gradient ──────────────────────
      m.addLayer({
        id: '3d-buildings',
        source: 'composite',
        'source-layer': 'building',
        filter: ['==', 'extrude', 'true'],
        type: 'fill-extrusion',
        minzoom: 12,
        paint: {
          'fill-extrusion-color': [
            'interpolate', ['linear'], ['get', 'height'],
            0,   '#0c1829',
            15,  '#0f2744',
            40,  '#0d3560',
            80,  '#1a4a8a',
            150, '#1d5ecc',
            250, '#2563eb',
          ],
          'fill-extrusion-height': [
            'interpolate', ['linear'], ['zoom'],
            12, 0,
            12.5, ['get', 'height'],
          ],
          'fill-extrusion-base': ['get', 'min_height'],
          'fill-extrusion-opacity': 0.88,
        },
      })

      // ── Outer halo for critical facilities (score >= 80) ─────────────────
      m.addLayer({
        id: 'facilities-halo',
        type: 'circle',
        source: 'facilities',
        filter: ['>=', ['get', 'final_score'], 80],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['get', 'final_score'], 80, 18, 100, 26],
          'circle-color': '#ef4444',
          'circle-opacity': 0.13,
          'circle-blur': 0.85,
        },
      })

      // ── Animated pulse ring (score >= 60, opacity driven by rAF) ─────────
      m.addLayer({
        id: 'facilities-pulse',
        type: 'circle',
        source: 'facilities',
        filter: ['>=', ['get', 'final_score'], 60],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['get', 'final_score'], 60, 11, 100, 20],
          'circle-color': ['interpolate', ['linear'], ['get', 'final_score'], 60, '#f97316', 80, '#ef4444'],
          'circle-opacity': 0.2,
          'circle-blur': 0.55,
        },
      })

      // ── Main facility dots ────────────────────────────────────────────────
      m.addLayer({
        id: 'facilities-layer',
        type: 'circle',
        source: 'facilities',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['get', 'final_score'], 0, 5, 100, 13],
          'circle-color': [
            'interpolate', ['linear'], ['get', 'final_score'],
            0, '#22c55e', 40, '#eab308', 60, '#f97316', 80, '#ef4444',
          ],
          'circle-opacity': 0.92,
          'circle-stroke-width': 1.5,
          'circle-stroke-color': 'rgba(255,255,255,0.55)',
        },
      })

      // Click: select + fly + popup
      m.on('click', 'facilities-layer', (e) => {
        if (!e.features?.[0]) return
        const feat = e.features[0]
        const facility: Facility = {
          properties: feat.properties as FacilityProperties,
          geometry: { coordinates: (feat.geometry as GeoJSON.Point).coordinates as [number, number] },
        }
        setSelected(facility)
        flyTo(facility)
      })

      m.on('mouseenter', 'facilities-layer', () => { m.getCanvas().style.cursor = 'pointer' })
      m.on('mouseleave', 'facilities-layer', () => { m.getCanvas().style.cursor = '' })

      setMapLoaded(true)

      // Smooth fly-in to GTA on load
      setTimeout(() => {
        m.flyTo({
          center: [-79.3832, 43.7532],
          zoom: 10.5,
          pitch: 60,
          bearing: -20,
          duration: 3400,
          essential: true,
          easing: (t) => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t,
        })
      }, 450)
    })
  }, [flyTo])

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: "'Inter','Segoe UI',sans-serif", position: 'relative', overflow: 'hidden' }}>

      {/* Popup + global overrides */}
      <style>{`
        .mg-popup .mapboxgl-popup-content {
          background: rgba(6,11,26,0.94) !important;
          backdrop-filter: blur(18px);
          border: 1px solid rgba(96,165,250,0.22) !important;
          border-radius: 12px !important;
          padding: 0 !important;
          box-shadow: 0 12px 40px rgba(0,0,0,0.7) !important;
        }
        .mg-popup .mapboxgl-popup-tip { display: none !important; }
        .mg-popup-inner  { padding: 13px 16px; }
        .mg-popup-name   { font-size: 13px; font-weight: 600; color: #e2e8f0; margin-bottom: 2px; }
        .mg-popup-city   { font-size: 11px; color: #64748b; margin-bottom: 8px; }
        .mg-popup-score  { font-size: 26px; font-weight: 700; line-height: 1; }
        .mg-popup-denom  { font-size: 12px; color: #64748b; font-weight: 400; }
        .mg-popup-rank   { font-size: 10px; color: #475569; margin-top: 3px; }

        input[type='range'] { -webkit-appearance: none; appearance: none; height: 4px; border-radius: 2px; background: rgba(255,255,255,0.1); }
        input[type='range']::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px; border-radius: 50%; background: #3b82f6; cursor: pointer; box-shadow: 0 0 8px #3b82f688; }
      `}</style>

      {/* ── LEFT SIDEBAR ────────────────────────────────────────────────── */}
      <div style={{
        width: '300px',
        background: 'rgba(6,11,26,0.78)',
        backdropFilter: 'blur(22px)',
        WebkitBackdropFilter: 'blur(22px)',
        borderRight: '1px solid rgba(96,165,250,0.12)',
        boxShadow: '4px 0 24px rgba(0,0,0,0.55)',
        color: 'white',
        overflowY: 'auto',
        padding: '20px 14px',
        flexShrink: 0,
        zIndex: 10,
      }}>
        {/* Header */}
        <div style={{ marginBottom: '18px' }}>
          <h2 style={{
            margin: '0 0 4px',
            fontSize: '18px',
            fontWeight: 700,
            background: 'linear-gradient(100deg, #60a5fa 0%, #06b6d4 100%)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
          }}>⚡ Microgrid Mapper</h2>
          <p style={{ margin: 0, fontSize: '11px', color: '#475569' }}>
            GTA Critical Facilities · Seneca Hackathon 2026
          </p>
        </div>

        {/* Score filter slider */}
        <div style={{
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: '10px',
          padding: '12px',
          marginBottom: '18px',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: '#64748b', marginBottom: '10px', letterSpacing: '0.06em' }}>
            <span>MIN SCORE FILTER</span>
            <span style={{ color: '#60a5fa', fontWeight: 600 }}>{minScore}+</span>
          </div>
          <input
            type="range" min={0} max={90} step={5} value={minScore}
            onChange={e => setMinScore(Number(e.target.value))}
            style={{ width: '100%', cursor: 'pointer', margin: 0, display: 'block' }}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: '#334155', marginTop: '6px' }}>
            <span>All</span><span>90+</span>
          </div>
        </div>

        {/* Top 10 list */}
        <div style={{ fontSize: '10px', color: '#475569', letterSpacing: '0.08em', marginBottom: '10px' }}>
          TOP 10 CANDIDATES
        </div>

        {topFacilities.map((f, i) => {
          const isActive = selected?.properties.name === f.properties.name
          return (
            <div
              key={i}
              onClick={() => { setSelected(f); flyTo(f) }}
              style={{
                background: isActive ? 'rgba(30,58,95,0.65)' : 'rgba(255,255,255,0.03)',
                borderRadius: '9px',
                padding: '10px 12px',
                marginBottom: '6px',
                cursor: 'pointer',
                borderTop: '1px solid rgba(255,255,255,0.05)',
                borderRight: '1px solid rgba(255,255,255,0.05)',
                borderBottom: '1px solid rgba(255,255,255,0.05)',
                borderLeft: `3px solid ${getScoreColor(f.properties.final_score)}`,
                outline: isActive ? '1px solid rgba(96,165,250,0.25)' : 'none',
                transition: 'background 0.18s',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div style={{ fontSize: '12px', fontWeight: 600, flex: 1, paddingRight: '8px', lineHeight: 1.35 }}>
                  <span style={{ color: '#475569', fontSize: '11px' }}>#{f.properties.rank} </span>
                  {f.properties.name}
                </div>
                <div style={{ fontSize: '14px', fontWeight: 700, color: getScoreColor(f.properties.final_score), flexShrink: 0 }}>
                  {f.properties.final_score}
                </div>
              </div>
              <div style={{ fontSize: '10px', color: '#475569', marginTop: '3px' }}>{f.properties.city}</div>
            </div>
          )
        })}
      </div>

      {/* ── MAP ─────────────────────────────────────────────────────────── */}
      <div ref={mapContainer} style={{ flex: 1, position: 'relative' }} />

      {/* ── LEGEND (bottom-center, floating) ────────────────────────────── */}
      <div style={{
        position: 'absolute',
        bottom: '28px',
        left: '50%',
        transform: 'translateX(-50%)',
        background: 'rgba(6,11,26,0.82)',
        backdropFilter: 'blur(18px)',
        WebkitBackdropFilter: 'blur(18px)',
        border: '1px solid rgba(96,165,250,0.12)',
        boxShadow: '0 4px 20px rgba(0,0,0,0.55)',
        borderRadius: '100px',
        padding: '9px 22px',
        display: 'flex',
        alignItems: 'center',
        gap: '18px',
        zIndex: 10,
        fontSize: '11px',
        pointerEvents: 'none',
        color: 'white',
      }}>
        <span style={{ color: '#334155', fontSize: '10px', letterSpacing: '0.06em' }}>PRIORITY</span>
        {[
          { color: '#22c55e', label: 'Low <40' },
          { color: '#eab308', label: '40–60' },
          { color: '#f97316', label: '60–80' },
          { color: '#ef4444', label: 'Critical >80' },
        ].map(({ color, label }) => (
          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <div style={{ width: '9px', height: '9px', borderRadius: '50%', background: color, boxShadow: `0 0 8px ${color}99`, flexShrink: 0 }} />
            <span style={{ color: '#94a3b8', whiteSpace: 'nowrap' }}>{label}</span>
          </div>
        ))}
      </div>

      {/* ── RIGHT DETAIL PANEL ──────────────────────────────────────────── */}
      {selected && (
        <div style={{
          width: '280px',
          background: 'rgba(6,11,26,0.78)',
          backdropFilter: 'blur(22px)',
          WebkitBackdropFilter: 'blur(22px)',
          borderLeft: '1px solid rgba(96,165,250,0.12)',
          boxShadow: '-4px 0 24px rgba(0,0,0,0.55)',
          color: 'white',
          padding: '20px 16px',
          overflowY: 'auto',
          flexShrink: 0,
          zIndex: 10,
        }}>
          {/* Header row */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <span style={{ fontSize: '10px', color: '#475569', letterSpacing: '0.08em' }}>FACILITY DETAILS</span>
            <button
              onClick={() => { setSelected(null); popup.current?.remove() }}
              style={{
                background: 'rgba(255,255,255,0.07)',
                border: '1px solid rgba(255,255,255,0.1)',
                color: '#94a3b8',
                cursor: 'pointer',
                width: '26px', height: '26px',
                borderRadius: '6px',
                fontSize: '14px',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0,
              }}
            >×</button>
          </div>

          {/* Score card */}
          <div style={{
            background: `rgba(${
              selected.properties.final_score >= 80 ? '239,68,68'
              : selected.properties.final_score >= 60 ? '249,115,22'
              : selected.properties.final_score >= 40 ? '234,179,8'
              : '34,197,94'
            },0.1)`,
            border: `1px solid ${getScoreColor(selected.properties.final_score)}33`,
            borderRadius: '12px',
            padding: '16px',
            marginBottom: '16px',
          }}>
            <div style={{ fontSize: '44px', fontWeight: 700, lineHeight: 1, color: getScoreColor(selected.properties.final_score) }}>
              {selected.properties.final_score}
              <span style={{ fontSize: '14px', fontWeight: 400, color: '#475569' }}>/100</span>
            </div>
            <div style={{ fontSize: '11px', color: '#64748b', marginTop: '4px' }}>Microgrid Viability Score</div>
            <div style={{ fontSize: '11px', color: '#475569', marginTop: '2px' }}>Rank #{selected.properties.rank} of 906</div>
          </div>

          {/* Name / type / city */}
          <div style={{ marginBottom: '16px' }}>
            <div style={{ fontSize: '14px', fontWeight: 600, lineHeight: 1.35, marginBottom: '4px' }}>{selected.properties.name}</div>
            <div style={{ fontSize: '11px', color: '#64748b' }}>{selected.properties.type}</div>
            <div style={{ fontSize: '11px', color: '#64748b' }}>{selected.properties.city}</div>
          </div>

          {/* Score breakdown */}
          <div style={{ marginBottom: '16px' }}>
            <div style={{ fontSize: '10px', color: '#475569', letterSpacing: '0.08em', marginBottom: '10px' }}>SCORE BREAKDOWN</div>
            <ScoreBar value={selected.properties.outage_risk_score} label="Outage Risk" />
            <ScoreBar value={selected.properties.solar_potential_score} label="Solar Potential" />
            <ScoreBar value={selected.properties.facility_score} label="Facility Criticality" />
          </div>

          {/* Recommendation */}
          <div style={{
            background: 'rgba(255,255,255,0.03)',
            border: '1px solid rgba(255,255,255,0.07)',
            borderRadius: '10px',
            padding: '12px',
            fontSize: '12px',
            color: '#cbd5e1',
            lineHeight: 1.6,
          }}>
            <div style={{ fontSize: '10px', color: '#475569', letterSpacing: '0.08em', marginBottom: '6px' }}>RECOMMENDATION</div>
            {selected.properties.final_score >= 80
              ? '🔴 High Priority — Immediate microgrid investment recommended'
              : selected.properties.final_score >= 60
              ? '🟠 Medium Priority — Plan for near-term deployment'
              : selected.properties.final_score >= 40
              ? '🟡 Moderate — Assess feasibility within 2 years'
              : '🟢 Lower Priority — Reassess annually'}
          </div>
        </div>
      )}
    </div>
  )
}
