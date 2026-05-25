import { useEffect, useRef, useState } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import './App.css'

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN

// Types
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
  geometry: {
    coordinates: [number, number]
  }
}

function getScoreColor(score: number): string {
  if (score >= 80) return '#ef4444' // red - highest priority
  if (score >= 60) return '#f97316' // orange
  if (score >= 40) return '#eab308' // yellow
  return '#22c55e'                  // green - lowest priority
}

function ScoreBar({ value, label }: { value: number, label: string }) {
  return (
    <div style={{ marginBottom: '8px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '3px' }}>
        <span>{label}</span>
        <span>{(value * 100).toFixed(0)}%</span>
      </div>
      <div style={{ background: '#e5e7eb', borderRadius: '4px', height: '6px' }}>
        <div style={{
          background: '#3b82f6',
          width: `${value * 100}%`,
          height: '100%',
          borderRadius: '4px'
        }} />
      </div>
    </div>
  )
}

function App() {
  const mapContainer = useRef<HTMLDivElement>(null)
  const map = useRef<mapboxgl.Map | null>(null)
  const [selected, setSelected] = useState<Facility | null>(null)
  const [topFacilities, setTopFacilities] = useState<Facility[]>([])

  useEffect(() => {
    if (map.current || !mapContainer.current) return

    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/dark-v11',
      center: [-79.3832, 43.6532], // Toronto
      zoom: 10
    })

    map.current.on('load', async () => {
      // Load GeoJSON
      const response = await fetch('./facilities.geojson')
      const data = await response.json()

      // Store top 10 for sidebar
      const sorted = [...data.features].sort(
        (a: Facility, b: Facility) => b.properties.final_score - a.properties.final_score
      )
      setTopFacilities(sorted.slice(0, 10))

      // Add source
      map.current!.addSource('facilities', {
        type: 'geojson',
        data: data
      })

      // Add circle layer
      map.current!.addLayer({
        id: 'facilities-layer',
        type: 'circle',
        source: 'facilities',
        paint: {
          'circle-radius': [
            'interpolate', ['linear'],
            ['get', 'final_score'],
            0, 4,
            100, 10
          ],
          'circle-color': [
            'interpolate', ['linear'],
            ['get', 'final_score'],
            0,  '#22c55e',
            40, '#eab308',
            60, '#f97316',
            80, '#ef4444'
          ],
          'circle-opacity': 0.85,
          'circle-stroke-width': 1,
          'circle-stroke-color': '#ffffff'
        }
      })

      // Click handler
      map.current!.on('click', 'facilities-layer', (e) => {
        if (!e.features || !e.features[0]) return
        const feature = e.features[0] as unknown as Facility
        setSelected(feature)
      })

      // Cursor change on hover
      map.current!.on('mouseenter', 'facilities-layer', () => {
        map.current!.getCanvas().style.cursor = 'pointer'
      })
      map.current!.on('mouseleave', 'facilities-layer', () => {
        map.current!.getCanvas().style.cursor = ''
      })
    })
  }, [])

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'sans-serif' }}>

      {/* LEFT SIDEBAR - Top Candidates */}
      <div style={{
        width: '300px',
        background: '#111827',
        color: 'white',
        overflowY: 'auto',
        padding: '16px',
        flexShrink: 0
      }}>
        <h2 style={{ margin: '0 0 4px 0', fontSize: '16px' }}>⚡ Microgrid Mapper</h2>
        <p style={{ margin: '0 0 16px 0', fontSize: '12px', color: '#9ca3af' }}>
          GTA Critical Facilities · Seneca Hackathon 2026
        </p>

        <h3 style={{ fontSize: '13px', color: '#9ca3af', marginBottom: '10px' }}>
          TOP 10 CANDIDATES
        </h3>

        {topFacilities.map((f, i) => (
          <div
            key={i}
            onClick={() => setSelected(f)}
            style={{
              background: selected?.properties.name === f.properties.name ? '#1e3a5f' : '#1f2937',
              borderRadius: '8px',
              padding: '10px',
              marginBottom: '8px',
              cursor: 'pointer',
              borderLeft: `3px solid ${getScoreColor(f.properties.final_score)}`
            }}
          >
            <div style={{ fontSize: '13px', fontWeight: 'bold', marginBottom: '2px' }}>
              #{f.properties.rank} {f.properties.name}
            </div>
            <div style={{ fontSize: '11px', color: '#9ca3af' }}>{f.properties.city}</div>
            <div style={{ fontSize: '12px', color: getScoreColor(f.properties.final_score), marginTop: '4px' }}>
              Score: {f.properties.final_score}/100
            </div>
          </div>
        ))}
      </div>

      {/* MAP */}
      <div ref={mapContainer} style={{ flex: 1 }} />

      {/* RIGHT PANEL - Selected Facility */}
      {selected && (
        <div style={{
          width: '280px',
          background: '#111827',
          color: 'white',
          padding: '16px',
          overflowY: 'auto',
          flexShrink: 0
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0, fontSize: '14px' }}>Facility Details</h3>
            <button
              onClick={() => setSelected(null)}
              style={{ background: 'none', border: 'none', color: 'white', cursor: 'pointer', fontSize: '18px' }}
            >×</button>
          </div>

          <div style={{
            background: '#1f2937',
            borderRadius: '8px',
            padding: '12px',
            marginTop: '12px'
          }}>
            <div style={{
              fontSize: '24px',
              fontWeight: 'bold',
              color: getScoreColor(selected.properties.final_score),
              marginBottom: '4px'
            }}>
              {selected.properties.final_score}/100
            </div>
            <div style={{ fontSize: '11px', color: '#9ca3af' }}>Microgrid Viability Score</div>
            <div style={{ fontSize: '11px', color: '#9ca3af' }}>Rank #{selected.properties.rank} of 906</div>
          </div>

          <div style={{ marginTop: '16px' }}>
            <div style={{ fontSize: '14px', fontWeight: 'bold', marginBottom: '4px' }}>
              {selected.properties.name}
            </div>
            <div style={{ fontSize: '12px', color: '#9ca3af' }}>{selected.properties.type}</div>
            <div style={{ fontSize: '12px', color: '#9ca3af' }}>{selected.properties.city}</div>
          </div>

          <div style={{ marginTop: '16px' }}>
            <div style={{ fontSize: '12px', color: '#9ca3af', marginBottom: '8px' }}>SCORE BREAKDOWN</div>
            <ScoreBar value={selected.properties.outage_risk_score} label="Outage Risk" />
            <ScoreBar value={selected.properties.solar_potential_score} label="Solar Potential" />
            <ScoreBar value={selected.properties.facility_score} label="Facility Criticality" />
          </div>

          <div style={{
            marginTop: '16px',
            background: '#1f2937',
            borderRadius: '8px',
            padding: '12px',
            fontSize: '12px'
          }}>
            <div style={{ color: '#9ca3af', marginBottom: '6px' }}>RECOMMENDATION</div>
            {selected.properties.final_score >= 80
              ? '🔴 High Priority — Immediate microgrid investment recommended'
              : selected.properties.final_score >= 60
              ? '🟠 Medium Priority — Plan for near-term microgrid deployment'
              : '🟢 Lower Priority — Monitor and reassess annually'}
          </div>
        </div>
      )}
    </div>
  )
}

export default App