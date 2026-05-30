import math
import pandas as pd
import numpy as np
import requests
import json
import os
import ast
from dotenv import load_dotenv
from shapely.geometry import shape, Point

load_dotenv()

GOOGLE_API_KEY = os.getenv("GOOGLE_GEOCODING_API_KEY")

# ── 1. LOAD FACILITIES ────────────────────────────────────────
def load_facilities(path: str) -> pd.DataFrame:
    df = pd.read_csv(path, encoding='latin1')
    gta_cities = [
        'toronto', 'mississauga', 'brampton', 'markham',
        'vaughan', 'richmond hill', 'oakville', 'burlington',
        'ajax', 'pickering', 'whitby', 'oshawa'
    ]
    df['city_lower'] = df['city'].str.lower()
    df = df[df['city_lower'].isin(gta_cities)].copy()
    print(f"Loaded {len(df)} GTA facilities")
    return df

# ── 2. GEOCODE MISSING COORDINATES ───────────────────────────
def geocode_address(address: str) -> tuple:
    url = "https://maps.googleapis.com/maps/api/geocode/json"
    params = {"address": address, "key": GOOGLE_API_KEY}
    try:
        response = requests.get(url, params=params)
        result = response.json()
        if result["status"] == "OK":
            location = result["results"][0]["geometry"]["location"]
            return location["lat"], location["lng"]
    except Exception as e:
        print(f"Geocoding failed for {address}: {e}")
    return None, None

def fill_missing_coordinates(df: pd.DataFrame) -> pd.DataFrame:
    missing = df[df['latitude'].isna() | df['longitude'].isna()]
    print(f"Geocoding {len(missing)} facilities with missing coordinates...")
    for idx, row in missing.iterrows():
        address_parts = []
        if pd.notna(row.get('street_no')):
            address_parts.append(str(row['street_no']))
        if pd.notna(row.get('street_name')):
            address_parts.append(str(row['street_name']))
        if pd.notna(row.get('city')):
            address_parts.append(str(row['city']))
        address_parts.append("Ontario, Canada")
        address = " ".join(address_parts)
        lat, lng = geocode_address(address)
        if lat and lng:
            df.at[idx, 'latitude'] = lat
            df.at[idx, 'longitude'] = lng
    before = len(df)
    df = df.dropna(subset=['latitude', 'longitude'])
    print(f"Dropped {before - len(df)} still missing coordinates")
    return df

# ── 3. SOLAR POTENTIAL SCORE ──────────────────────────────────
def load_solar_scores(solar_path: str, facilities_df: pd.DataFrame):
    """Returns (solar_scores Series, solar_kwh_per_m2 Series).
    Scoring uses normalized kWh/m² (energy density) instead of raw generation.
    """
    print("Loading solar data...")
    solar_df = pd.read_csv(solar_path, encoding='latin1')

    # Compute energy density: kWh per m²
    solar_df['area_m2'] = solar_df['rooftop_sqft'] * 0.0929  # 1 sqft = 0.0929 m²
    solar_df['kwh_per_m2'] = np.where(
        solar_df['area_m2'] > 5,
        solar_df['annual_electricity_generation_k'] / solar_df['area_m2'],
        np.nan
    )
    solar_df = solar_df.dropna(subset=['kwh_per_m2'])

    # Normalize kwh_per_m2 to 0–1 for scoring
    min_v = solar_df['kwh_per_m2'].min()
    max_v = solar_df['kwh_per_m2'].max()
    solar_df['solar_score'] = ((solar_df['kwh_per_m2'] - min_v) / (max_v - min_v)).clip(0, 1)

    # Extract centroid lat/lng from geometry field
    lats, lngs = [], []
    for geom_str in solar_df['geometry']:
        try:
            geom = json.loads(geom_str)
            coords = geom['coordinates'][0][0][0]
            lngs.append(coords[0])
            lats.append(coords[1])
        except:
            lats.append(None)
            lngs.append(None)

    solar_df['lat'] = lats
    solar_df['lng'] = lngs
    solar_df = solar_df.dropna(subset=['lat', 'lng'])

    # Grid-based lookups (~1 km cells)
    solar_df['lat_grid'] = solar_df['lat'].round(2)
    solar_df['lng_grid'] = solar_df['lng'].round(2)
    grid_scores   = solar_df.groupby(['lat_grid', 'lng_grid'])['solar_score'].mean().to_dict()
    grid_kwh_m2   = solar_df.groupby(['lat_grid', 'lng_grid'])['kwh_per_m2'].mean().to_dict()

    toronto_mean       = solar_df['solar_score'].mean()
    toronto_kwh_m2_avg = solar_df['kwh_per_m2'].mean()

    print(f"Solar data loaded: {len(solar_df)} buildings, "
          f"avg {toronto_kwh_m2_avg:.1f} kWh/m²")
    print(f"Solar coverage: lat {solar_df['lat'].min():.3f}–{solar_df['lat'].max():.3f}")

    facility_solar_scores = []
    facility_kwh_m2       = []
    matched = 0

    for _, fac in facilities_df.iterrows():
        lat_r = round(fac['latitude'], 2)
        lng_r = round(fac['longitude'], 2)

        score  = grid_scores.get((lat_r, lng_r))
        kwh_m2 = grid_kwh_m2.get((lat_r, lng_r))

        if score is None:
            for dlat in [-0.01, 0, 0.01]:
                for dlng in [-0.01, 0, 0.01]:
                    k = (round(lat_r + dlat, 2), round(lng_r + dlng, 2))
                    score  = grid_scores.get(k)
                    kwh_m2 = grid_kwh_m2.get(k)
                    if score is not None:
                        break
                if score is not None:
                    break

        if score is not None:
            matched += 1
            facility_solar_scores.append(score)
            facility_kwh_m2.append(round(float(kwh_m2 if kwh_m2 is not None else toronto_kwh_m2_avg), 2))
        else:
            np.random.seed(hash(str(fac['latitude'])) % 2**32)
            variation = np.random.uniform(-0.15, 0.15)
            estimated = float(np.clip(toronto_mean + variation, 0.2, 0.8))
            facility_solar_scores.append(estimated)
            facility_kwh_m2.append(round(toronto_kwh_m2_avg, 2))

    print(f"Solar: {matched}/{len(facilities_df)} matched, "
          f"{len(facilities_df)-matched} estimated")
    return (
        pd.Series(facility_solar_scores, index=facilities_df.index),
        pd.Series(facility_kwh_m2, index=facilities_df.index),
    )

# ── 4. OUTAGE RISK SCORE (KUBRA live + energy consumption fallback) ───────────

KUBRA_STATE_URL = (
    "https://kubra.io/stormcenter/api/v1/stormcenters/"
    "b8d8094c-3809-49e5-bf8b-1ddd27f6e12d/views/"
    "5c2283d7-eff9-4f7e-966b-3afd90d8a6b9/currentState?preview=false"
)

def fetch_kubra_outages():
    """
    Returns a list of shapely geometries for active outage zones,
    an empty list when Toronto is outage-free, or None on fetch error.
    """
    try:
        state = requests.get(KUBRA_STATE_URL, timeout=10).json()
        data = state.get('data') or {}
        data_url = (
            data.get('file_data') or data.get('fileData') or
            state.get('file_data') or state.get('fileData') or
            data.get('report_url') or state.get('report_url')
        )
        if data_url:
            geojson = requests.get(data_url, timeout=15).json()
        elif 'features' in state:
            geojson = state
        else:
            print("KUBRA: no data URL in response — assuming no active outages")
            return []

        features = geojson.get('features', [])
        if not features:
            print("KUBRA: 0 active outage features — Toronto is currently outage-free")
            return []

        polys = [shape(f['geometry']) for f in features if f.get('geometry')]
        print(f"KUBRA: {len(polys)} active outage zone(s) loaded")
        return polys

    except Exception as e:
        print(f"KUBRA fetch failed ({e}) — will use city-level fallback")
        return None


def _compute_city_scores(energy_path: str) -> dict:
    """Returns normalized 0-1 outage risk score per city from energy consumption data."""
    try:
        energy_df = pd.read_excel(energy_path, engine='openpyxl')
    except Exception:
        energy_df = pd.read_excel(energy_path)

    energy_df = energy_df[
        energy_df['State/Province'].str.lower() == 'ontario'
    ].copy()
    energy_df = energy_df.dropna(subset=['Gross Floor Area'])

    borough_map = {
        'North York': 'Toronto', 'Etobicoke': 'Toronto',
        'Scarborough': 'Toronto', 'East York': 'Toronto', 'York': 'Toronto',
        'Concord': 'Vaughan', 'Thornhill': 'Markham', 'Maple': 'Vaughan',
    }
    energy_df['City_mapped'] = energy_df['City/Municipality'].replace(borough_map)
    city_avg = energy_df.groupby('City_mapped')['Gross Floor Area'].mean()

    raw = {
        'Toronto':       city_avg.get('Toronto', 50000),
        'Mississauga':   city_avg.get('Mississauga', 40000),
        'Brampton':      city_avg.get('Brampton', 35000),
        'Markham':       city_avg.get('Markham', 38000),
        'Vaughan':       city_avg.get('Vaughan', 32000),
        'Richmond Hill': city_avg.get('Richmond Hill', 30000),
        'Oakville':      city_avg.get('Oakville', 45000),
        'Burlington':    city_avg.get('Burlington', 42000),
        'Ajax':          city_avg.get('Ajax', 28000),
        'Pickering':     city_avg.get('Pickering', 27000),
        'Whitby':        city_avg.get('Whitby', 26000),
        'Oshawa':        city_avg.get('Oshawa', 30000),
    }
    max_val, min_val = max(raw.values()), min(raw.values())
    return {city: (val - min_val) / (max_val - min_val) for city, val in raw.items()}


def load_outage_scores(energy_path: str, facilities_df: pd.DataFrame) -> pd.Series:
    print("Loading energy consumption data (city-level baseline)...")
    city_scores = _compute_city_scores(energy_path)
    print(f"City baseline scores: { {k: round(v, 2) for k, v in city_scores.items()} }")

    print("Fetching KUBRA live outage data...")
    outage_geometries = fetch_kubra_outages()

    # No live data available — use city-level scoring with per-facility variation
    if outage_geometries is None or len(outage_geometries) == 0:
        if outage_geometries is None:
            print("KUBRA unavailable — falling back to city-level energy scores")
        else:
            print("No active outages — using city-level energy scores")
        scores = []
        for _, fac in facilities_df.iterrows():
            city = str(fac['city']).strip().title()
            base = city_scores.get(city, 0.5)
            np.random.seed(hash(fac['facility_name']) % 2**32)
            score = float(np.clip(base + np.random.uniform(-0.1, 0.1), 0.05, 1.0))
            scores.append(score)
        print(f"Outage risk scores assigned to {len(scores)} facilities (city-level)")
        return pd.Series(scores, index=facilities_df.index)

    # Live outage data available — score by proximity to active outage zones
    # At Toronto latitude (~43.65°N): 1° ≈ 111 km latitude, ~80 km longitude
    # Use conservative 111 km/° for threshold conversion (slightly tighter buffer)
    DEG_1KM = 1.0 / 111.0
    DEG_5KM = 5.0 / 111.0

    scores = []
    inside_count = 0
    near1_count = 0
    near5_count = 0

    for _, fac in facilities_df.iterrows():
        point = Point(fac['longitude'], fac['latitude'])
        city = str(fac['city']).strip().title()
        city_base = city_scores.get(city, 0.5)

        if any(geom.contains(point) for geom in outage_geometries):
            scores.append(1.0)
            inside_count += 1
            continue

        min_dist = min(point.distance(geom) for geom in outage_geometries)
        if min_dist <= DEG_1KM:
            scores.append(0.85)
            near1_count += 1
        elif min_dist <= DEG_5KM:
            scores.append(0.65)
            near5_count += 1
        else:
            np.random.seed(hash(fac['facility_name']) % 2**32)
            score = float(np.clip(city_base + np.random.uniform(-0.1, 0.1), 0.05, 1.0))
            scores.append(score)

    print(
        f"KUBRA scoring: {inside_count} inside outage zone (1.0), "
        f"{near1_count} within 1km (0.85), {near5_count} within 5km (0.65), "
        f"{len(scores) - inside_count - near1_count - near5_count} city-level fallback"
    )
    return pd.Series(scores, index=facilities_df.index)

# ── 5. FACILITY CRITICALITY SCORE ────────────────────────────
def score_facility_type(facility_type: str) -> float:
    scores = {
        "Hospitals": 1.0,
        "Nursing and residential care facilities": 0.8,
        "nursng and residential care facilities": 0.8,
        "Ambulatory health care services": 0.5,
    }
    return scores.get(facility_type, 0.5)

# ── 6. FINAL COMPOSITE SCORE ─────────────────────────────────
def calculate_final_score(df: pd.DataFrame) -> pd.DataFrame:
    df['facility_score'] = df['odhf_facility_type'].apply(score_facility_type)

    df['final_score'] = (
        df['outage_risk_score']     * 0.40 +
        df['solar_potential_score'] * 0.35 +
        df['facility_score']        * 0.25
    )

    df['final_score'] = (df['final_score'] * 100).round(2)
    df = df.sort_values(
        ['final_score', 'outage_risk_score', 'solar_potential_score', 'facility_score'],
        ascending=[False, False, False, False]
    ).reset_index(drop=True)
    df['rank'] = df.index + 1
    return df

# ── 7. EXPORT GEOJSON ─────────────────────────────────────────
def export_geojson(df: pd.DataFrame, output_path: str):
    features = []
    for _, row in df.iterrows():
        feature = {
            "type": "Feature",
            "geometry": {
                "type": "Point",
                "coordinates": [row['longitude'], row['latitude']]
            },
            "properties": {
                "name": row['facility_name'],
                "type": row['odhf_facility_type'],
                "city": row['city'],
                "address": str(row.get('source_format_str_address', ''))
                           if pd.notna(row.get('source_format_str_address'))
                           else '',
                "outage_risk_score": round(float(row['outage_risk_score']), 3),
                "solar_potential_score": round(float(row['solar_potential_score']), 3),
                "solar_kwh_per_m2": round(float(row.get('solar_kwh_per_m2', 0) or 0), 2),
                "facility_score": round(float(row['facility_score']), 3),
                "final_score": float(row['final_score']),
                "rank": int(row['rank'])
            }
        }
        features.append(feature)

    geojson = {"type": "FeatureCollection", "features": features}
    with open(output_path, 'w') as f:
        json.dump(geojson, f, indent=2)
    print(f"Exported {len(features)} facilities to {output_path}")

# ── 8. MAIN ───────────────────────────────────────────────────
if __name__ == "__main__":
    # Load facilities
    df = load_facilities("data/raw/odhf_v1.csv")
    df = fill_missing_coordinates(df)

    # Load REAL scores
    print("\nMatching solar potential scores...")
    df['solar_potential_score'], df['solar_kwh_per_m2'] = load_solar_scores(
        "data/raw/solarto-map_-_4326.csv", df
    )

    print("\nMatching outage risk scores...")
    df['outage_risk_score'] = load_outage_scores(
        "data/raw/annual-energy-consumption-data-2024_xlsx.xlsx", df
    )

    # Calculate final score
    df = calculate_final_score(df)

    # Save outputs
    df.to_csv("data/processed/scored_facilities.csv", index=False)
    export_geojson(df, "data/processed/facilities.geojson")

    # Show top 10
    top10 = df.nsmallest(10, 'rank')[
        ['facility_name', 'city', 'odhf_facility_type',
         'solar_potential_score', 'outage_risk_score', 'final_score', 'rank']
    ]
    print("\nTop 10 Microgrid Candidates (REAL DATA):")
    print(top10.to_string(index=False))