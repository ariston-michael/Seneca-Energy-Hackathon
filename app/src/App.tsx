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

export default function App() {
  const mapContainer = useRef<HTMLDivElement>(null)
  const cityContainer = useRef<HTMLDivElement>(null)
  const map = useRef<mapboxgl.Map | null>(null)
  const popup = useRef<mapboxgl.Popup | null>(null)
  const animRef = useRef<number>(0)
  const cityFocusRef = useRef<((f: Facility) => void) | null>(null)
  const cityResetRef = useRef<(() => void) | null>(null)

  const [viewMode, setViewMode] = useState<'map' | 'city'>('map')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [selected, setSelected] = useState<Facility | null>(null)
  const [topFacilities, setTopFacilities] = useState<Facility[]>([])
  const [allFeatures, setAllFeatures] = useState<Facility[]>([])
  const [minScore, setMinScore] = useState(0)
  const [mapLoaded, setMapLoaded] = useState(false)
  const [tooltip, setTooltip] = useState<{ x: number; y: number; name: string; score: number } | null>(null)

  const flyTo = useCallback((f: Facility) => {
    if (!map.current) return
    const [lng, lat] = f.geometry.coordinates
    const [clampedLng, clampedLat] = clampFlyCoords(lng, lat)
    map.current.flyTo({ center: [clampedLng, clampedLat], zoom: 15, pitch: 60, bearing: -20, duration: 1600, essential: true })
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

  // Map pulse animation
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

  // Score filter for map
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
      center: [-79.3832, 43.65], zoom: 10, pitch: 55, bearing: -20,
      antialias: true, maxBounds: [GTA_SW, GTA_NE], minZoom: 10, maxZoom: 18,
    })
    map.current.on('load', async () => {
      const m = map.current!
      ;(m as any).setFog({
        color: 'rgb(10, 15, 30)', 'high-color': 'rgb(20, 40, 80)',
        'horizon-blend': 0.1, 'space-color': 'rgb(5, 10, 20)', 'star-intensity': 0.5,
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
      m.addLayer({ id: 'facilities-halo', type: 'circle', source: 'facilities', filter: ['>=', ['get', 'final_score'], 80], paint: { 'circle-radius': ['interpolate', ['linear'], ['get', 'final_score'], 80, 18, 100, 26], 'circle-color': '#ef4444', 'circle-opacity': 0.13, 'circle-blur': 0.85 } })
      m.addLayer({ id: 'facilities-pulse', type: 'circle', source: 'facilities', filter: ['>=', ['get', 'final_score'], 60], paint: { 'circle-radius': ['interpolate', ['linear'], ['get', 'final_score'], 60, 11, 100, 20], 'circle-color': ['interpolate', ['linear'], ['get', 'final_score'], 60, '#f97316', 80, '#ef4444'], 'circle-opacity': 0.2, 'circle-blur': 0.55 } })
      m.addLayer({ id: 'top5-ring', type: 'circle', source: 'facilities', filter: ['<=', ['get', 'rank'], 5], paint: { 'circle-radius': 32, 'circle-color': 'rgba(0,0,0,0)', 'circle-opacity': 0, 'circle-stroke-width': 2.5, 'circle-stroke-color': '#ef4444', 'circle-stroke-opacity': 0.6 } })
      m.addLayer({ id: 'facilities-layer', type: 'circle', source: 'facilities', paint: { 'circle-radius': ['interpolate', ['linear'], ['get', 'final_score'], 0, 5, 100, 13], 'circle-color': ['interpolate', ['linear'], ['get', 'final_score'], 0, '#22c55e', 40, '#eab308', 60, '#f97316', 80, '#ef4444'], 'circle-opacity': 0.92, 'circle-stroke-width': 1.5, 'circle-stroke-color': 'rgba(255,255,255,0.55)' } })
      m.on('click', 'facilities-layer', (e) => {
        if (!e.features?.[0]) return
        const feat = e.features[0]
        const facility: Facility = { properties: feat.properties as FacilityProperties, geometry: { coordinates: (feat.geometry as GeoJSON.Point).coordinates as [number, number] } }
        setSelected(facility); flyTo(facility)
      })
      m.on('mouseenter', 'facilities-layer', () => { m.getCanvas().style.cursor = 'pointer' })
      m.on('mouseleave', 'facilities-layer', () => { m.getCanvas().style.cursor = '' })
      setMapLoaded(true)
      setTimeout(() => { m.flyTo({ center: [-79.3832, 43.72], zoom: 11, pitch: 55, bearing: -20, duration: 3400, essential: true, easing: (t) => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t }) }, 450)
    })
  }, [flyTo])

  // Three.js city model — rebuilt when viewMode, allFeatures, or minScore changes
  useEffect(() => {
    if (viewMode !== 'city' || !cityContainer.current || allFeatures.length === 0) return

    const container = cityContainer.current
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x0a0f1e)
    scene.fog = new THREE.FogExp2(0x0a0f1e, 0.004)

    const w = container.clientWidth
    const h = container.clientHeight
    const camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1000)
    camera.position.set(30, 100, 130)
    camera.lookAt(0, 10, 0)

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setSize(w, h)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.domElement.style.display = 'block'
    container.appendChild(renderer.domElement)

    // Lighting
    scene.add(new THREE.AmbientLight(0xffffff, 0.4))
    const dirLight = new THREE.DirectionalLight(0x4facfe, 1.2)
    dirLight.position.set(50, 100, 50)
    scene.add(dirLight)
    scene.add(new THREE.PointLight(0x3b82f6, 0.8, 200))
    scene.add(new THREE.HemisphereLight(0x1e3a5f, 0x0a0f1e, 0.5))

    // Ground
    const gnd = new THREE.Mesh(
      new THREE.PlaneGeometry(250, 250),
      new THREE.MeshPhongMaterial({ color: 0x050b18, shininess: 5 })
    )
    gnd.rotation.x = -Math.PI / 2
    gnd.position.y = -0.1
    scene.add(gnd)

    // Starfield
    const starPos = new Float32Array(2000 * 3)
    for (let i = 0; i < 2000; i++) {
      starPos[i * 3] = (Math.random() - 0.5) * 800
      starPos[i * 3 + 1] = Math.random() * 300 + 100
      starPos[i * 3 + 2] = (Math.random() - 0.5) * 800
    }
    const starGeo = new THREE.BufferGeometry()
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3))
    scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.3 })))

    // Shared window texture for buildings
    const winCanvas = document.createElement('canvas')
    winCanvas.width = 64; winCanvas.height = 128
    const winCtx = winCanvas.getContext('2d')!
    winCtx.fillStyle = '#000810'
    winCtx.fillRect(0, 0, 64, 128)
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

    // Neighborhood zones — downtown max height 60
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
            // Window overlay for tall buildings
            if (bh > 8) {
              const wm = new THREE.Mesh(new THREE.BoxGeometry(bw * 0.99, bh * 0.99, bd * 0.99), winMat)
              wm.position.copy(b.position); wm.rotation.copy(b.rotation)
              scene.add(wm)
            }
            // Bloom halo for tall buildings
            if (bh > 15) {
              const bl = new THREE.Mesh(
                new THREE.BoxGeometry(bw * 1.15, bh * 1.05, bd * 1.15),
                new THREE.MeshBasicMaterial({ color: zone.color, opacity: 0.1, transparent: true })
              )
              bl.position.copy(b.position); bl.rotation.copy(b.rotation)
              scene.add(bl)
            }
          }
        }
      }
    }

    // Minor road grid
    {
      const pts: number[] = []
      for (let rx = -60; rx <= 60; rx += 2) { pts.push(rx, 0.05, -60, rx, 0.05, 60) }
      for (let rz = -60; rz <= 60; rz += 2) { pts.push(-60, 0.05, rz, 60, 0.05, rz) }
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
      scene.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x0f172a, opacity: 0.3, transparent: true })))
    }

    // Major road grid (pulsing — store material ref)
    const gridMat = new THREE.LineBasicMaterial({ color: 0x1e40af, opacity: 0.4, transparent: true })
    {
      const pts: number[] = []
      for (let rx = -60; rx <= 60; rx += 5) { pts.push(rx, 0.06, -60, rx, 0.06, 60) }
      for (let rz = -60; rz <= 60; rz += 5) { pts.push(-60, 0.06, rz, 60, 0.06, rz) }
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
      scene.add(new THREE.LineSegments(g, gridMat))
    }

    // Yonge Street — bright wide plane (x=0, vertical)
    {
      const yonge = new THREE.Mesh(
        new THREE.PlaneGeometry(0.5, 120),
        new THREE.MeshBasicMaterial({ color: 0x60a5fa, opacity: 0.85, transparent: true })
      )
      yonge.rotation.x = -Math.PI / 2
      yonge.position.set(0, 0.08, 0)
      scene.add(yonge)
    }

    // Bloor/Danforth (z=-8)
    {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute([-60, 0.08, -8, 60, 0.08, -8], 3))
      scene.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x2563eb })))
    }

    // Highway 401 — thick horizontal plane at z=-25
    {
      const hwy = new THREE.Mesh(
        new THREE.PlaneGeometry(120, 1.0),
        new THREE.MeshBasicMaterial({ color: 0x1d4ed8, opacity: 0.9, transparent: true })
      )
      hwy.rotation.x = -Math.PI / 2
      hwy.position.set(0, 0.09, -25)
      scene.add(hwy)
    }

    // Highway 427/400 — vertical planes at x=-35 and x=-15
    for (const hx of [-35, -15]) {
      const hwy = new THREE.Mesh(
        new THREE.PlaneGeometry(0.6, 120),
        new THREE.MeshBasicMaterial({ color: 0x1d4ed8, opacity: 0.75, transparent: true })
      )
      hwy.rotation.x = -Math.PI / 2
      hwy.position.set(hx, 0.09, 0)
      scene.add(hwy)
    }

    // Lake Ontario — improved material
    const lakeGeo = new THREE.PlaneGeometry(140, 60, 40, 20)
    const lakeMesh = new THREE.Mesh(
      lakeGeo,
      new THREE.MeshStandardMaterial({ color: 0x0369a1, opacity: 0.85, transparent: true, metalness: 0.8, roughness: 0.2 })
    )
    lakeMesh.rotation.x = -Math.PI / 2
    lakeMesh.position.set(0, -0.05, 42)
    scene.add(lakeMesh)
    const lakePosAttr = lakeGeo.attributes.position as THREE.BufferAttribute

    // Shoreline glow plane
    {
      const shore = new THREE.Mesh(
        new THREE.PlaneGeometry(140, 3),
        new THREE.MeshBasicMaterial({ color: 0x0ea5e9, opacity: 0.3, transparent: true })
      )
      shore.rotation.x = -Math.PI / 2
      shore.position.set(0, 0.15, 15)
      scene.add(shore)
    }

    // Facility cylinders — filtered by minScore, height 8
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
      cyl.position.set(sx, cylH / 2, sz)
      scene.add(cyl)

      // Crown cone on #1
      let crown: THREE.Mesh | undefined
      if (isTop1) {
        crown = new THREE.Mesh(
          new THREE.ConeGeometry(0.9, 2.0, 6),
          new THREE.MeshStandardMaterial({ color: 0xfbbf24, emissive: 0xfbbf24, emissiveIntensity: 1.2, metalness: 0.9, roughness: 0.1 })
        )
        crown.position.set(sx, cylH + 1.0, sz)
        scene.add(crown)
      }

      const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
        color: baseColor, opacity: 0.6, transparent: true, side: THREE.DoubleSide,
      }))
      ring.rotation.x = -Math.PI / 2
      ring.position.set(sx, 0.15, sz)
      scene.add(ring)

      cylEntries.push({ cylinder: cyl, ring, facility: f, crown })

      // Point light for top 5
      if (f.properties.rank <= 5) {
        const pl = new THREE.PointLight(new THREE.Color(getScoreColor(f.properties.final_score)), 2, 15)
        pl.position.set(sx, cylH, sz)
        scene.add(pl)
      }
    }

    // OrbitControls
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.05
    controls.minDistance = 20
    controls.maxDistance = 200
    controls.maxPolarAngle = Math.PI / 2.2
    controls.autoRotate = true
    controls.autoRotateSpeed = 0.2
    controls.target.set(0, 10, 0)
    controls.update()
    controls.addEventListener('start', () => { controls.autoRotate = false })

    // Camera lerp utility
    const lerpCamera = (toPos: THREE.Vector3, toTarget: THREE.Vector3) => {
      const fromPos = camera.position.clone()
      const fromTarget = controls.target.clone()
      const duration = 1200
      const start = performance.now()
      controls.autoRotate = false
      const tick = () => {
        const t = Math.min((performance.now() - start) / duration, 1)
        const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t
        camera.position.lerpVectors(fromPos, toPos, ease)
        controls.target.lerpVectors(fromTarget, toTarget, ease)
        controls.update()
        if (t < 1) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    }

    cityResetRef.current = () => lerpCamera(new THREE.Vector3(30, 100, 130), new THREE.Vector3(0, 10, 0))

    // Per-selected-entry fast pulse tracking
    const selectedEntryRef = { current: null as CylEntry | null }
    const fastPulseUntil = { current: 0 }

    cityFocusRef.current = (f: Facility) => {
      const entry = cylEntries.find(e => e.facility.properties.name === f.properties.name)
      setSelected(f)
      if (!entry) return
      const sx = entry.cylinder.position.x
      const sz = entry.cylinder.position.z
      lerpCamera(new THREE.Vector3(sx + 20, 40, sz + 40), new THREE.Vector3(sx, 0, sz))
      selectedEntryRef.current = entry
      fastPulseUntil.current = performance.now() + 3000
    }

    // Raycaster
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
          hoveredEntry = found
          renderer.domElement.style.cursor = 'pointer'
          const proj = found.cylinder.position.clone().project(camera)
          setTooltip({
            x: (proj.x * 0.5 + 0.5) * container.clientWidth,
            y: (-proj.y * 0.5 + 0.5) * container.clientHeight,
            name: found.facility.properties.name,
            score: found.facility.properties.final_score,
          })
        }
      } else {
        hoveredEntry = null
        renderer.domElement.style.cursor = 'default'
        setTooltip(null)
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

    // Animation loop
    let rafId: number
    const clock = new THREE.Clock()
    const animate = () => {
      rafId = requestAnimationFrame(animate)
      const t = clock.getElapsedTime()

      // Pulsing grid
      gridMat.opacity = 0.08 + 0.05 * Math.sin(t * 0.5)

      // Lake waves
      for (let vi = 0; vi < lakePosAttr.count; vi++) {
        const vx = lakePosAttr.getX(vi)
        const vy = lakePosAttr.getY(vi)
        lakePosAttr.setZ(vi, Math.sin(t * 0.8 + vx * 0.15) * 0.3 + Math.cos(t * 0.5 + vy * 0.12) * 0.2)
      }
      lakePosAttr.needsUpdate = true
      lakeGeo.computeVertexNormals()

      // Cylinders
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

      controls.update()
      renderer.render(scene, camera)
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
      cityFocusRef.current = null
      cityResetRef.current = null
      controls.dispose()
      renderer.dispose()
      if (container.contains(renderer.domElement)) container.removeChild(renderer.domElement)
      setTooltip(null)
    }
  }, [viewMode, allFeatures, minScore, setSelected, setTooltip])

  return (
    <div style={{ width: '100vw', height: '100vh', fontFamily: "'Inter','Segoe UI',sans-serif", position: 'relative', overflow: 'hidden' }}>

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
        .mg-collapse-btn { transition: background 200ms ease; }
        .mg-collapse-btn:hover { background: rgba(255,255,255,0.2) !important; }
        .mg-reset-btn { transition: background 200ms ease, box-shadow 200ms ease; }
        .mg-reset-btn:hover { background: rgba(255,255,255,0.18) !important; box-shadow: 0 8px 24px rgba(0,0,0,0.5) !important; }
        input[type='range'] { -webkit-appearance: none; appearance: none; height: 4px; border-radius: 2px; background: rgba(255,255,255,0.12); }
        input[type='range']::-webkit-slider-thumb { -webkit-appearance: none; width: 16px; height: 16px; border-radius: 50%; background: rgba(255,255,255,0.9); cursor: pointer; border: 1px solid rgba(255,255,255,0.5); box-shadow: 0 0 12px rgba(255,255,255,0.35), 0 2px 6px rgba(0,0,0,0.35); }
        .mg-toggle-btn { background: transparent; border: none; color: rgba(255,255,255,0.5); font-size: 13px; font-weight: 500; padding: 8px 18px; cursor: pointer; border-radius: 100px; transition: all 200ms ease; white-space: nowrap; font-family: inherit; }
        .mg-toggle-btn.active { background: rgba(37,99,235,0.75); color: white; box-shadow: 0 0 16px rgba(37,99,235,0.5), inset 0 1px 0 rgba(255,255,255,0.25); }
        .mg-toggle-btn:hover:not(.active) { background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.85); }
      `}</style>

      {/* Mapbox — always in DOM */}
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

      {/* Left sidebar — collapsible */}
      <div style={{
        position: 'absolute', top: '20px', left: '20px',
        width: sidebarCollapsed ? '48px' : '380px',
        transition: 'width 300ms ease',
        maxHeight: 'calc(100vh - 40px)',
        ...glass,
        overflowY: sidebarCollapsed ? 'hidden' : 'auto',
        overflowX: 'hidden',
        padding: '14px 8px',
        zIndex: 10,
      }}>
        <GlassTopHighlight />

        {/* Collapse/expand button */}
        <button
          className="mg-collapse-btn"
          onClick={() => setSidebarCollapsed(v => !v)}
          style={{
            position: 'absolute', top: '12px', right: '8px',
            width: '28px', height: '28px',
            background: 'rgba(255,255,255,0.12)',
            backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
            border: '1px solid rgba(255,255,255,0.22)',
            borderRadius: '100px',
            color: 'rgba(255,255,255,0.85)',
            cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '16px', fontWeight: 700, zIndex: 2,
            lineHeight: 1,
          }}
        >
          {sidebarCollapsed ? '›' : '‹'}
        </button>

        {/* Sidebar content — hidden when collapsed */}
        <div style={{
          opacity: sidebarCollapsed ? 0 : 1,
          height: sidebarCollapsed ? 0 : 'auto',
          overflow: 'hidden',
          transition: 'opacity 300ms ease',
          pointerEvents: sidebarCollapsed ? 'none' : 'auto',
          paddingTop: '4px',
        }}>
          <div style={{ marginBottom: '18px', paddingRight: '36px' }}>
            <h2 style={{
              margin: '0 0 4px', fontSize: '18px', fontWeight: 700,
              background: 'linear-gradient(100deg, #60a5fa 0%, #06b6d4 100%)',
              WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
            }}>Microgrid Mapper</h2>
            <p style={{ margin: 0, fontSize: '11px', color: 'rgba(255,255,255,0.32)', textShadow: '0 1px 2px rgba(0,0,0,0.5)' }}>GTA Critical Facilities</p>
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
                onClick={() => {
                  if (viewMode === 'map') { setSelected(f); flyTo(f) }
                  else { cityFocusRef.current?.(f) }
                }}
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
                  <div style={{ fontSize: '14px', fontWeight: 700, color: getScoreColor(f.properties.final_score), flexShrink: 0, textShadow: `0 0 12px ${getScoreColor(f.properties.final_score)}77` }}>
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

      {/* Reset View button — city mode only */}
      {viewMode === 'city' && (
        <button
          className="mg-reset-btn"
          onClick={() => cityResetRef.current?.()}
          style={{
            position: 'absolute', bottom: '80px', right: '20px',
            ...glass, borderRadius: '100px',
            padding: '9px 20px', border: 'none',
            color: 'rgba(255,255,255,0.8)',
            cursor: 'pointer', fontSize: '12px', fontWeight: 500,
            fontFamily: "'Inter','Segoe UI',sans-serif",
            zIndex: 10, letterSpacing: '0.04em',
          }}
        >
          Reset View
        </button>
      )}

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
            background: `rgba(${selected.properties.final_score >= 80 ? '239,68,68' : selected.properties.final_score >= 60 ? '249,115,22' : selected.properties.final_score >= 40 ? '234,179,8' : '34,197,94'},0.12)`,
            border: `1px solid ${getScoreColor(selected.properties.final_score)}44`,
            borderRadius: '14px', padding: '16px', marginBottom: '16px',
            boxShadow: `inset 0 1px 0 rgba(255,255,255,0.12), 0 0 24px ${getScoreColor(selected.properties.final_score)}22`,
          }}>
            <div style={{ fontSize: '44px', fontWeight: 700, lineHeight: 1, color: getScoreColor(selected.properties.final_score), textShadow: `0 0 24px ${getScoreColor(selected.properties.final_score)}77` }}>
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

      {/* Floating tooltip — City Model hover */}
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
    </div>
  )
}
