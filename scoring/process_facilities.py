import pandas as pd
import numpy as np
import requests
import json
import os
from dotenv import load_dotenv

load_dotenv()

GOOGLE_API_KEY = os.getenv("GOOGLE_GEOCODING_API_KEY")

# ── 1. LOAD DATA ──────────────────────────────────────────────
def load_facilities(path: str) -> pd.DataFrame:
    df = pd.read_csv(path, encoding='latin1')
    
    # Filter to GTA only
    gta_cities = [
        'toronto', 'mississauga', 'brampton', 'markham',
        'vaughan', 'richmond hill', 'oakville', 'burlington',
        'ajax', 'pickering', 'whitby', 'oshawa'
    ]
    df['city_lower'] = df['city'].str.lower()
    df = df[df['city_lower'].isin(gta_cities)].copy()
    
    print(f"Loaded {len(df)} GTA facilities")
    return df


# ── 2. GEOCODE MISSING COORDINATES ────────────────────────────
def geocode_address(address: str) -> tuple:
    """Call Google Geocoding API to get lat/long from address"""
    url = "https://maps.googleapis.com/maps/api/geocode/json"
    params = {
        "address": address,
        "key": GOOGLE_API_KEY
    }
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
        # Build address string from available fields
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
    
    # Drop any still missing after geocoding
    before = len(df)
    df = df.dropna(subset=['latitude', 'longitude'])
    print(f"Dropped {before - len(df)} facilities still missing coordinates")
    return df


# ── 3. FACILITY CRITICALITY SCORE ─────────────────────────────
def score_facility_type(facility_type: str) -> float:
    """
    Score based on how critical the facility is.
    Hospitals need power the most = highest score.
    """
    scores = {
        "Hospitals": 1.0,
        "Nursing and residential care facilities": 0.8,
        "nursng and residential care facilities": 0.8,  # typo in data
        "Ambulatory health care services": 0.5,
    }
    return scores.get(facility_type, 0.5)


# ── 4. PLACEHOLDER SCORES (until real data arrives) ───────────
def add_placeholder_scores(df: pd.DataFrame) -> pd.DataFrame:
    """
    Temporary random scores for outage risk and solar potential.
    These will be REPLACED when teammates bring real datasets.
    """
    np.random.seed(42)
    df['outage_risk_score'] = np.random.uniform(0, 1, len(df))
    df['solar_potential_score'] = np.random.uniform(0, 1, len(df))
    return df


# ── 5. FINAL COMPOSITE SCORE ──────────────────────────────────
def calculate_final_score(df: pd.DataFrame) -> pd.DataFrame:
    """
    Weighted scoring formula:
    - Outage Risk:       40% (places that need backup power most)
    - Solar Potential:   35% (places where solar microgrid is viable)
    - Facility Type:     25% (hospitals weighted highest)
    """
    df['facility_score'] = df['odhf_facility_type'].apply(score_facility_type)
    
    df['final_score'] = (
        df['outage_risk_score']     * 0.40 +
        df['solar_potential_score'] * 0.35 +
        df['facility_score']        * 0.25
    )
    
    # Normalize to 0-100
    df['final_score'] = (df['final_score'] * 100).round(2)
    
    # Rank them
    df['rank'] = df['final_score'].rank(ascending=False).astype(int)
    
    return df


# ── 6. EXPORT TO GEOJSON ──────────────────────────────────────
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
                "address": row.get('source_format_str_address', ''),
                "outage_risk_score": round(row['outage_risk_score'], 3),
                "solar_potential_score": round(row['solar_potential_score'], 3),
                "facility_score": round(row['facility_score'], 3),
                "final_score": row['final_score'],
                "rank": row['rank']
            }
        }
        features.append(feature)
    
    geojson = {
        "type": "FeatureCollection",
        "features": features
    }
    
    with open(output_path, 'w') as f:
        json.dump(geojson, f, indent=2)
    
    print(f"Exported {len(features)} facilities to {output_path}")


# ── 7. MAIN ───────────────────────────────────────────────────
if __name__ == "__main__":
    # Load
    df = load_facilities("data/raw/odhf_v1.csv")
    
    # Geocode missing
    df = fill_missing_coordinates(df)
    
    # Score
    df = add_placeholder_scores(df)
    df = calculate_final_score(df)
    
    # Save scored CSV
    df.to_csv("data/processed/scored_facilities.csv", index=False)
    
    # Export GeoJSON for the map
    export_geojson(df, "data/processed/facilities.geojson")
    
    # Preview top 10
    top10 = df.nsmallest(10, 'rank')[
        ['facility_name', 'city', 'odhf_facility_type', 'final_score', 'rank']
    ]
    print("\nTop 10 Microgrid Candidates:")
    print(top10.to_string(index=False))