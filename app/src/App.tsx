import { useEffect, useRef, useState, useCallback } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import './App.css'

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN

const GTA_SW: [number, number] = [-79.85, 43.45]
const GTA_NE: [number, number] = [-78.8, 44.1]
const EDGE_MARGIN = 0.05
const SCENE_W = 80
const SCENE_D = 60
const DOWNTOWN: [number, number] = [-79.3832, 43.6532]

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

function clampFlyCoords(lng: number, lat: number): [number, number] {
  return [
    Math.max(GTA_SW[0] + EDGE_MARGIN, Math.min(GTA_NE[0] - EDGE_MARGIN, lng)),
    Math.max(GTA_SW[1] + EDGE_MARGIN, Math.min(GTA_NE[1] - EDGE_MARGIN, lat)),
  ]
}

function coordToScene(lng: number, lat: number): [number, number] {
  const tx = (lng - GTA_SW[0]) / (GTA_NE[0] - GTA_SW[0])
  const tz = 1 - (lat - GTA_SW[1]) / (GTA_NE[1] - GTA_SW[1])
  return [(tx - 0.5) * SCENE_W, (tz - 0.5) * SCENE_D]
}

function neighborhoodHeight(lng: number, lat: number): number {
  const dLng = (lng - DOWNTOWN[0]) * Math.cos((lat * Math.PI) / 180) * 111
  const dLat = (lat - DOWNTOWN[1]) * 111
  const distKm = Math.sqrt(dLng * dLng + dLat * dLat)
  return Math.max(0.4, 10 * Math.exp(-distKm / 8))
}

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
        background: 'rgba(255,255,255,0.08)',
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
        border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: '4px',
        height: '5px',
      }}>
        <div style={{
          background: `linear-gradient(90deg, ${col}88, ${col})`,
          boxShadow: `0 0 10px ${col}99`,
          width: `${pct}%`,
          height: '100%',
          borderRadius: '4px',
        }} />
      </div>
    </div>
  )
}

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
      position: 'absolute',
      top: 0, left: '10%', right: '10%',
      height: '1px',
      background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.35), transparent)',
      pointerEvents: 'none',
    }} />
  )
}

export default function App() {
  const mapContainer = useRef<HTMLDivElement>(null)
  const cityContainer = useRef<HTMLDivElement>(null)
  const map = useRef<mapboxgl.Map | null>(null)
  const popup = useRef<mapboxgl.Popup | null>(null)
  const animRef = useRef<number>(0)

  const [viewMode, setViewMode] = useState<'map' | 'city'>('map')
  const [selected, setSelected] = useState<Facility | null>(null)
  const [topFacilities, setTopFacilities] = useState<Facility[]>([])
  const [allFeatures, setAllFeatures] = useState<Facility[]>([])
  const [minScore, setMinScore] = useState(0)
  const [mapLoaded, setMapLoaded] = useState(false)

  const flyTo = useCallback((f: Facility) => {
    if (!map.current) return
    const [lng, lat] = f.geometry.coordinates
    const [clampedLng, clampedLat] = clampFlyCoords(lng, lat)
    map.current.flyTo({
      center: [clampedLng, clampedLat],
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

  // Pulse animation for map layers
  useEffect(() => {
    if (!mapLoaded) return
    let t0: number | null = null
    const tick = (ts: number) => {
      if (!t0) t0 = ts
      const elapsed = (ts - t0) / 1000
      const pulseOpacity = 0.1 + 0.22 * Math.abs(Math.sin(elapsed * 1.3))
      const ringOpacity = 0.3 + 0.55 * Math.abs(Math.sin(elapsed * 1.8))
      if (map.current?.getLayer('facilities-pulse')) {
        map.current.setPaintProperty('facilities-pulse', 'circle-opacity', pulseOpacity)
      }
      if (map.current?.getLayer('top5-ring')) {
        map.current.setPaintProperty('top5-ring', 'circle-stroke-opacity', ringOpacity)
      }
      animRef.current = requestAnimationFrame(tick)
    }
    animRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(animRef.current)
  }, [mapLoaded])

  // Score filter
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

  // Map initialisation
  useEffect(() => {
    if (map.current || !mapContainer.current) return

    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/navigation-night-v1',
      center: [-79.3832, 43.65],
      zoom: 10,
      pitch: 55,
      bearing: -20,
      antialias: true,
      maxBounds: [GTA_SW, GTA_NE],
      minZoom: 10,
      maxZoom: 18,
    })

    map.current.on('load', async () => {
      const m = map.current!

      ;(m as any).setFog({
        color: 'rgb(10, 15, 30)',
        'high-color': 'rgb(20, 40, 80)',
        'horizon-blend': 0.1,
        'space-color': 'rgb(5, 10, 20)',
        'star-intensity': 0.5,
      })

      const res = await fetch('./facilities.geojson')
      const data = await res.json()
      const sorted = [...data.features].sort(
        (a: Facility, b: Facility) => b.properties.final_score - a.properties.final_score
      )
      setTopFacilities(sorted.slice(0, 10))
      setAllFeatures(data.features)

      m.addSource('facilities', { type: 'geojson', data })

      // 3D buildings (only if composite source exists in this style)
      if (m.getSource('composite')) {
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
              0,   '#0d1b2a',
              15,  '#0f2744',
              40,  '#1e3a5f',
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
      }

      // Outer halo (critical)
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

      // Animated pulse ring
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

      // Top 5 pulsing outline ring
      m.addLayer({
        id: 'top5-ring',
        type: 'circle',
        source: 'facilities',
        filter: ['<=', ['get', 'rank'], 5],
        paint: {
          'circle-radius': 32,
          'circle-color': 'rgba(0,0,0,0)',
          'circle-opacity': 0,
          'circle-stroke-width': 2.5,
          'circle-stroke-color': '#ef4444',
          'circle-stroke-opacity': 0.6,
        },
      })

      // Main facility dots
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

      setTimeout(() => {
        m.flyTo({
          center: [-79.3832, 43.72],
          zoom: 11,
          pitch: 55,
          bearing: -20,
          duration: 3400,
          essential: true,
          easing: (t) => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t,
        })
      }, 450)
    })
  }, [flyTo])

  // Three.js city model — created/destroyed on view switch
  useEffect(() => {
    if (viewMode !== 'city' || !cityContainer.current || allFeatures.length === 0) return

    const container = cityContainer.current
    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#0a0f1e')
    scene.fog = new THREE.FogExp2(0x0a1a3a, 0.006)

    const w = container.clientWidth
    const h = container.clientHeight
    const camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1000)
    camera.position.set(20, 70, 55)
    camera.lookAt(0, 0, 0)

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setSize(w, h)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.domElement.style.display = 'block'
    container.appendChild(renderer.domElement)

    // Lighting
    scene.add(new THREE.AmbientLight(0x223366, 0.8))
    const dirLight = new THREE.DirectionalLight(0x4477cc, 1.5)
    dirLight.position.set(30, 80, 40)
    scene.add(dirLight)
    const rimLight = new THREE.DirectionalLight(0x1144aa, 0.4)
    rimLight.position.set(-40, 20, -40)
    scene.add(rimLight)

    // Ground
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(SCENE_W + 10, SCENE_D + 10),
      new THREE.MeshPhongMaterial({ color: '#050b18', shininess: 5 })
    )
    ground.rotation.x = -Math.PI / 2
    ground.position.y = -0.1
    scene.add(ground)

    // City grid buildings — density driven by distance from downtown
    const GRID_X = 35
    const GRID_Z = 28
    const CELL = 2.0
    for (let i = 0; i < GRID_X; i++) {
      for (let j = 0; j < GRID_Z; j++) {
        const lng = GTA_SW[0] + (i / (GRID_X - 1)) * (GTA_NE[0] - GTA_SW[0])
        const lat = GTA_SW[1] + (j / (GRID_Z - 1)) * (GTA_NE[1] - GTA_SW[1])
        const bh = neighborhoodHeight(lng, lat)
        const color = bh >= 6 ? '#2563eb' : bh >= 2 ? '#1e3a5f' : '#0d1b2a'
        const mesh = new THREE.Mesh(
          new THREE.BoxGeometry(CELL, bh, CELL),
          new THREE.MeshPhongMaterial({ color, shininess: 30, specular: 0x224488 })
        )
        const tx = i / (GRID_X - 1)
        const tz = 1 - j / (GRID_Z - 1)
        mesh.position.set((tx - 0.5) * SCENE_W, bh / 2, (tz - 0.5) * SCENE_D)
        scene.add(mesh)
      }
    }

    // Facility spheres
    const sphereEntries: { mesh: THREE.Mesh; facility: Facility }[] = []
    for (const f of allFeatures) {
      const [lng, lat] = f.geometry.coordinates
      const [sx, sz] = coordToScene(lng, lat)
      const bh = neighborhoodHeight(lng, lat)
      const color = getScoreColor(f.properties.final_score)
      const mat = new THREE.MeshPhongMaterial({
        color, emissive: color, emissiveIntensity: 0.6, shininess: 80,
      })
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 8), mat)
      mesh.position.set(sx, bh + 1.2, sz)
      scene.add(mesh)
      sphereEntries.push({ mesh, facility: f })
    }

    // OrbitControls
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.05
    controls.maxPolarAngle = Math.PI / 2.1
    controls.minDistance = 20
    controls.maxDistance = 200

    // Raycaster for click/hover
    const raycaster = new THREE.Raycaster()
    const mouse = new THREE.Vector2()
    const sphereMeshes = sphereEntries.map(s => s.mesh)

    const handleClick = (e: MouseEvent) => {
      const rect = renderer.domElement.getBoundingClientRect()
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(mouse, camera)
      const hits = raycaster.intersectObjects(sphereMeshes)
      if (hits.length > 0) {
        const entry = sphereEntries.find(s => s.mesh === hits[0].object)
        if (entry) setSelected(entry.facility)
      }
    }

    const handleMouseMove = (e: MouseEvent) => {
      const rect = renderer.domElement.getBoundingClientRect()
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(mouse, camera)
      renderer.domElement.style.cursor =
        raycaster.intersectObjects(sphereMeshes).length > 0 ? 'pointer' : 'default'
    }

    renderer.domElement.addEventListener('click', handleClick)
    renderer.domElement.addEventListener('mousemove', handleMouseMove)

    // Animation loop with sphere pulse
    let rafId: number
    const clock = new THREE.Clock()
    const animate = () => {
      rafId = requestAnimationFrame(animate)
      const t = clock.getElapsedTime()
      for (const { mesh, facility } of sphereEntries) {
        const mat = mesh.material as THREE.MeshPhongMaterial
        mat.emissiveIntensity = 0.3 + 0.5 * Math.abs(Math.sin(t * 1.5 + (facility.properties.final_score / 100) * 5))
      }
      controls.update()
      renderer.render(scene, camera)
    }
    animate()

    const handleResize = () => {
      const nw = container.clientWidth
      const nh = container.clientHeight
      camera.aspect = nw / nh
      camera.updateProjectionMatrix()
      renderer.setSize(nw, nh)
    }
    window.addEventListener('resize', handleResize)

    return () => {
      cancelAnimationFrame(rafId)
      renderer.domElement.removeEventListener('click', handleClick)
      renderer.domElement.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('resize', handleResize)
      controls.dispose()
      renderer.dispose()
      if (container.contains(renderer.domElement)) container.removeChild(renderer.domElement)
    }
  }, [viewMode, allFeatures])

  return (
    <div style={{ width: '100vw', height: '100vh', fontFamily: "'Inter','Segoe UI',sans-serif", position: 'relative', overflow: 'hidden' }}>

      <style>{`
        .mg-popup .mapboxgl-popup-content {
          background: rgba(255,255,255,0.10) !important;
          backdrop-filter: blur(60px) saturate(200%) !important;
          -webkit-backdrop-filter: blur(60px) saturate(200%) !important;
          border: 1px solid rgba(255,255,255,0.22) !important;
          border-radius: 18px !important;
          padding: 0 !important;
          box-shadow: 0 8px 32px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.2), inset 0 0 20px rgba(255,255,255,0.05) !important;
        }
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
        input[type='range'] { -webkit-appearance: none; appearance: none; height: 4px; border-radius: 2px; background: rgba(255,255,255,0.12); }
        input[type='range']::-webkit-slider-thumb { -webkit-appearance: none; width: 16px; height: 16px; border-radius: 50%; background: rgba(255,255,255,0.9); cursor: pointer; border: 1px solid rgba(255,255,255,0.5); box-shadow: 0 0 12px rgba(255,255,255,0.35), 0 2px 6px rgba(0,0,0,0.35); }
        .mg-toggle-btn { background: transparent; border: none; color: rgba(255,255,255,0.5); font-size: 13px; font-weight: 500; padding: 8px 18px; cursor: pointer; border-radius: 100px; transition: all 200ms ease; white-space: nowrap; font-family: inherit; }
        .mg-toggle-btn.active { background: rgba(37,99,235,0.75); color: white; box-shadow: 0 0 16px rgba(37,99,235,0.5), inset 0 1px 0 rgba(255,255,255,0.25); }
        .mg-toggle-btn:hover:not(.active) { background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.85); }
      `}</style>

      {/* Mapbox — always in DOM so it stays initialised */}
      <div ref={mapContainer} style={{
        position: 'absolute', inset: 0,
        opacity: viewMode === 'map' ? 1 : 0,
        pointerEvents: viewMode === 'map' ? 'auto' : 'none',
        transition: 'opacity 400ms ease',
        zIndex: viewMode === 'map' ? 1 : 0,
      }} />

      {/* Three.js canvas container */}
      <div ref={cityContainer} style={{
        position: 'absolute', inset: 0,
        background: '#0a0f1e',
        opacity: viewMode === 'city' ? 1 : 0,
        pointerEvents: viewMode === 'city' ? 'auto' : 'none',
        transition: 'opacity 400ms ease',
        zIndex: viewMode === 'city' ? 1 : 0,
      }} />

      {/* View toggle — glass pill top center */}
      <div style={{
        position: 'absolute', top: '20px', left: '50%', transform: 'translateX(-50%)',
        ...glass, borderRadius: '100px', padding: '4px',
        display: 'flex', alignItems: 'center', gap: '2px', zIndex: 20,
      }}>
        <GlassTopHighlight />
        <button className={`mg-toggle-btn${viewMode === 'map' ? ' active' : ''}`} onClick={() => setViewMode('map')}>
          Map View
        </button>
        <button className={`mg-toggle-btn${viewMode === 'city' ? ' active' : ''}`} onClick={() => setViewMode('city')}>
          City Model
        </button>
      </div>

      {/* Left sidebar */}
      <div style={{
        position: 'absolute', top: '20px', left: '20px', width: '290px',
        maxHeight: 'calc(100vh - 40px)', ...glass,
        overflowY: 'auto', overflowX: 'hidden', padding: '20px 14px',
        zIndex: 10, display: 'flex', flexDirection: 'column',
      }}>
        <GlassTopHighlight />

        <div style={{ marginBottom: '18px' }}>
          <h2 style={{
            margin: '0 0 4px', fontSize: '18px', fontWeight: 700,
            background: 'linear-gradient(100deg, #60a5fa 0%, #06b6d4 100%)',
            WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
          }}>Microgrid Mapper</h2>
          <p style={{ margin: 0, fontSize: '11px', color: 'rgba(255,255,255,0.32)', textShadow: '0 1px 2px rgba(0,0,0,0.5)' }}>
            GTA Critical Facilities · Seneca Hackathon 2026
          </p>
        </div>

        <div style={{
          position: 'relative', background: 'rgba(255,255,255,0.06)',
          backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
          border: '1px solid rgba(255,255,255,0.14)', borderRadius: '14px',
          padding: '12px', marginBottom: '18px',
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

        <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.32)', letterSpacing: '0.08em', marginBottom: '10px', textShadow: '0 1px 2px rgba(0,0,0,0.5)' }}>
          TOP 10 CANDIDATES
        </div>

        {topFacilities.map((f, i) => {
          const isActive = selected?.properties.name === f.properties.name
          return (
            <div
              key={i}
              className="mg-card"
              onClick={() => { setSelected(f); if (viewMode === 'map') flyTo(f) }}
              style={{
                background: isActive ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.06)',
                backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
                borderRadius: '14px', padding: '10px 12px', marginBottom: '6px',
                border: isActive ? '1px solid rgba(255,255,255,0.32)' : '1px solid rgba(255,255,255,0.10)',
                borderLeft: `3px solid ${getScoreColor(f.properties.final_score)}`,
                boxShadow: isActive
                  ? '0 8px 24px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.22)'
                  : '0 4px 12px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.08)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div style={{ fontSize: '12px', fontWeight: 600, flex: 1, paddingRight: '8px', lineHeight: 1.35, textShadow: '0 1px 3px rgba(0,0,0,0.5)' }}>
                  <span style={{ color: 'rgba(255,255,255,0.32)', fontSize: '11px' }}>#{f.properties.rank} </span>
                  {f.properties.name}
                </div>
                <div style={{
                  fontSize: '14px', fontWeight: 700,
                  color: getScoreColor(f.properties.final_score), flexShrink: 0,
                  textShadow: `0 0 12px ${getScoreColor(f.properties.final_score)}77`,
                }}>
                  {f.properties.final_score}
                </div>
              </div>
              <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.32)', marginTop: '3px', textShadow: '0 1px 2px rgba(0,0,0,0.4)' }}>
                {f.properties.city}
              </div>
            </div>
          )
        })}
      </div>

      {/* Legend */}
      <div style={{
        position: 'absolute', bottom: '28px', left: '50%', transform: 'translateX(-50%)',
        ...glass, borderRadius: '100px', padding: '10px 26px',
        display: 'flex', alignItems: 'center', gap: '20px',
        zIndex: 10, fontSize: '11px', pointerEvents: 'none', whiteSpace: 'nowrap',
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

      {/* Right detail panel */}
      {selected && (
        <div style={{
          position: 'absolute', top: '20px', right: '20px', width: '280px',
          maxHeight: 'calc(100vh - 40px)', ...glass,
          overflowY: 'auto', padding: '20px 16px', zIndex: 10,
        }}>
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
            background: `rgba(${
              selected.properties.final_score >= 80 ? '239,68,68'
              : selected.properties.final_score >= 60 ? '249,115,22'
              : selected.properties.final_score >= 40 ? '234,179,8'
              : '34,197,94'
            },0.12)`,
            border: `1px solid ${getScoreColor(selected.properties.final_score)}44`,
            borderRadius: '14px', padding: '16px', marginBottom: '16px',
            boxShadow: `inset 0 1px 0 rgba(255,255,255,0.12), 0 0 24px ${getScoreColor(selected.properties.final_score)}22`,
          }}>
            <div style={{
              fontSize: '44px', fontWeight: 700, lineHeight: 1,
              color: getScoreColor(selected.properties.final_score),
              textShadow: `0 0 24px ${getScoreColor(selected.properties.final_score)}77`,
            }}>
              {selected.properties.final_score}
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
            <ScoreBar value={selected.properties.facility_score} label="Facility Criticality" />
          </div>

          <div style={{
            background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.10)',
            backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
            borderRadius: '12px', padding: '12px', fontSize: '12px',
            color: 'rgba(255,255,255,0.72)', lineHeight: 1.6,
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08)', textShadow: '0 1px 2px rgba(0,0,0,0.4)',
          }}>
            <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.32)', letterSpacing: '0.08em', marginBottom: '6px' }}>RECOMMENDATION</div>
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
