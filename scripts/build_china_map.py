from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / "data" / "source" / "geojson-cn"
ROADS_CACHE_PATH = ROOT / "data" / "source" / "ne-roads-china.geojson"
PROJECTS_PATH = ROOT / "public" / "data" / "projects.json"
PUBLIC_PATH = ROOT / "public" / "data" / "china-map.json"

WIDTH = 1000
PADDING = 28
ROAD_ENDPOINT = "https://services1.arcgis.com/cc7nIINtrZ67dyVJ/arcgis/rest/services/Natural_Earth_Features/FeatureServer/4/query"
ROAD_WHERE = "type IN ('Major Highway','Secondary Highway','Road') AND scalerank <= 7"
ROAD_BATCH_SIZE = 220
ROAD_BOUNDS = (73.0, 18.0, 136.0, 54.0)
ROAD_SIMPLIFY = {
    "motorway": 0.68,
    "trunk": 0.82,
    "primary": 0.96,
}


def mercator(lng: float, lat: float) -> tuple[float, float]:
    lat = max(-85.0, min(85.0, lat))
    x = math.radians(lng)
    y = math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
    return x, y


def point_line_distance(point: tuple[float, float], start: tuple[float, float], end: tuple[float, float]) -> float:
    if start == end:
        return math.hypot(point[0] - start[0], point[1] - start[1])
    x, y = point
    x1, y1 = start
    x2, y2 = end
    dx = x2 - x1
    dy = y2 - y1
    t = max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)))
    return math.hypot(x - (x1 + t * dx), y - (y1 + t * dy))


def simplify(points: list[tuple[float, float]], tolerance: float) -> list[tuple[float, float]]:
    if len(points) <= 3:
        return points

    def rdp(segment: list[tuple[float, float]]) -> list[tuple[float, float]]:
        if len(segment) <= 2:
            return segment
        start = segment[0]
        end = segment[-1]
        max_distance = 0.0
        index = 0
        for i in range(1, len(segment) - 1):
            distance = point_line_distance(segment[i], start, end)
            if distance > max_distance:
                max_distance = distance
                index = i
        if max_distance > tolerance:
            return rdp(segment[: index + 1])[:-1] + rdp(segment[index:])
        return [start, end]

    closed = points[0] == points[-1]
    work = points[:-1] if closed else points
    result = rdp(work)
    if closed and result[0] != result[-1]:
        result.append(result[0])
    return result


def geometry_rings(feature: dict[str, Any]) -> list[list[list[float]]]:
    geometry = feature.get("geometry") or {}
    kind = geometry.get("type")
    coordinates = geometry.get("coordinates") or []
    if kind == "Polygon":
        return coordinates
    if kind == "MultiPolygon":
        return [ring for polygon in coordinates for ring in polygon]
    return []


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def curl_json(url: str, params: dict[str, Any]) -> dict[str, Any]:
    command = ["curl", "-sS", "-A", "Codex/1.0", "-G", url]
    for key, value in params.items():
        command.extend(["--data-urlencode", f"{key}={value}"])
    result = subprocess.run(
        command,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or f"curl failed: {url}")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        snippet = result.stdout[:300].replace("\n", " ")
        raise RuntimeError(f"invalid json from {url}: {snippet}") from error


def road_path(points: list[tuple[float, float]]) -> str:
    if len(points) < 2:
        return ""
    head = points[0]
    body = " ".join(f"L{point[0]:.1f},{point[1]:.1f}" for point in points[1:])
    return f"M{head[0]:.1f},{head[1]:.1f} {body}"


def road_class(road_type: str) -> str | None:
    if road_type == "Major Highway":
        return "motorway"
    if road_type == "Secondary Highway":
        return "trunk"
    if road_type == "Road":
        return "primary"
    return None


def coord_in_bounds(lng: float, lat: float, padding: float = 1.1) -> bool:
    west, south, east, north = ROAD_BOUNDS
    return west - padding <= lng <= east + padding and south - padding <= lat <= north + padding


def clip_coords(coords: list[list[float]]) -> list[list[list[float]]]:
    segments: list[list[list[float]]] = []
    current: list[list[float]] = []
    for index, point in enumerate(coords):
        lng, lat = point
        prev_inside = index > 0 and coord_in_bounds(coords[index - 1][0], coords[index - 1][1])
        next_inside = index + 1 < len(coords) and coord_in_bounds(coords[index + 1][0], coords[index + 1][1])
        keep = coord_in_bounds(lng, lat) or prev_inside or next_inside
        if keep:
            current.append(point)
        elif len(current) >= 2:
            segments.append(current)
            current = []
        else:
            current = []
    if len(current) >= 2:
        segments.append(current)
    return segments


def fetch_road_cache(refresh: bool) -> dict[str, Any]:
    if ROADS_CACHE_PATH.exists() and not refresh:
        return load_json(ROADS_CACHE_PATH)

    ids_payload = curl_json(
        ROAD_ENDPOINT,
        {
            "where": ROAD_WHERE,
            "returnIdsOnly": "true",
            "geometry": ",".join(str(value) for value in ROAD_BOUNDS),
            "geometryType": "esriGeometryEnvelope",
            "inSR": "4326",
            "spatialRel": "esriSpatialRelIntersects",
            "f": "pjson",
        },
    )
    object_ids = ids_payload.get("objectIds", [])
    features: list[dict[str, Any]] = []
    for start in range(0, len(object_ids), ROAD_BATCH_SIZE):
        batch = object_ids[start : start + ROAD_BATCH_SIZE]
        print(f"fetching roads {start + 1}-{start + len(batch)} / {len(object_ids)}...", flush=True)
        batch_payload = curl_json(
            ROAD_ENDPOINT,
            {
                "objectIds": ",".join(str(item) for item in batch),
                "outFields": "type,scalerank,name",
                "returnGeometry": "true",
                "f": "geojson",
            },
        )
        features.extend(batch_payload.get("features", []))
    payload = {"type": "FeatureCollection", "features": features}
    ROADS_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    ROADS_CACHE_PATH.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return payload


def collect_roads(refresh_roads: bool) -> list[dict[str, Any]]:
    payload = fetch_road_cache(refresh_roads)
    roads: list[dict[str, Any]] = []
    for index, feature in enumerate(payload.get("features", [])):
        geometry = feature.get("geometry") or {}
        coords = geometry.get("coordinates") or []
        if geometry.get("type") != "LineString" or len(coords) < 2:
            continue
        klass = road_class((feature.get("properties") or {}).get("type", ""))
        if not klass:
            continue
        for segment in clip_coords(coords):
            roads.append({"id": index * 10 + len(roads), "class": klass, "coords": segment})
    return roads


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--refresh-roads", action="store_true")
    args = parser.parse_args()

    country = load_json(SOURCE_DIR / "100000.json")
    projects = load_json(PROJECTS_PATH)
    province_counts = projects["metadata"].get("provinceCounts", {})

    raw_points: list[tuple[float, float]] = []
    for feature in country["features"]:
        for ring in geometry_rings(feature):
            raw_points.extend(mercator(point[0], point[1]) for point in ring)

    min_x = min(point[0] for point in raw_points)
    max_x = max(point[0] for point in raw_points)
    min_y = min(point[1] for point in raw_points)
    max_y = max(point[1] for point in raw_points)
    projected_width = max_x - min_x
    projected_height = max_y - min_y
    height = round(WIDTH * projected_height / projected_width)
    scale = (WIDTH - PADDING * 2) / projected_width
    content_height = projected_height * scale
    y_offset = (height - content_height) / 2

    def project(lng: float, lat: float) -> tuple[float, float]:
        x, y = mercator(lng, lat)
        return round(PADDING + (x - min_x) * scale, 2), round(y_offset + (max_y - y) * scale, 2)

    def ring_to_path(ring: list[list[float]], tolerance: float) -> str:
        points = [project(point[0], point[1]) for point in ring]
        points = simplify(points, tolerance)
        if len(points) < 3:
            return ""
        head = points[0]
        body = " ".join(f"L{point[0]:.1f},{point[1]:.1f}" for point in points[1:])
        return f"M{head[0]:.1f},{head[1]:.1f} {body} Z"

    roads = collect_roads(args.refresh_roads)

    provinces: list[dict[str, Any]] = []
    cities: list[dict[str, Any]] = []
    city_paths: list[dict[str, Any]] = []
    road_paths: list[dict[str, Any]] = []

    for index, feature in enumerate(country["features"]):
        properties = feature["properties"]
        if "code" not in properties:
            continue
        name = properties["name"]
        fullname = properties.get("fullname", name)
        center = properties.get("center") or [0, 0]
        path = " ".join(filter(None, (ring_to_path(ring, 0.75) for ring in geometry_rings(feature))))
        label_x, label_y = project(center[0], center[1])
        provinces.append(
            {
                "code": properties["code"],
                "name": name,
                "fullname": fullname,
                "path": path,
                "label": {"x": label_x, "y": label_y},
                "count": province_counts.get(name, province_counts.get(fullname, 0)),
                "colorIndex": index,
            }
        )

        province_file = SOURCE_DIR / f"{properties['filename']}.json"
        if not province_file.exists():
            continue
        province_geojson = load_json(province_file)
        for city in province_geojson.get("features", []):
            city_props = city["properties"]
            city_center = city_props.get("center") or center
            city_x, city_y = project(city_center[0], city_center[1])
            cities.append(
                {
                    "province": name,
                    "name": city_props["name"],
                    "fullname": city_props.get("fullname", city_props["name"]),
                    "x": city_x,
                    "y": city_y,
                }
            )
            city_path = " ".join(filter(None, (ring_to_path(ring, 1.25) for ring in geometry_rings(city))))
            if city_path:
                city_paths.append({"province": name, "name": city_props["name"], "path": city_path})

    for road in roads:
        points = [project(lng, lat) for lng, lat in road["coords"]]
        simplified = simplify(points, ROAD_SIMPLIFY[road["class"]])
        path = road_path(simplified)
        if not path:
            continue
        road_paths.append({"id": road["id"], "class": road["class"], "path": path})

    payload = {
        "metadata": {
            "source": "GeoJSON.CN",
            "sourceUrl": "https://geojson.cn/data/atlas/china",
            "roadSource": "Natural Earth Roads via ArcGIS FeatureServer",
            "roadSourceUrl": "https://services1.arcgis.com/cc7nIINtrZ67dyVJ/arcgis/rest/services/Natural_Earth_Features/FeatureServer/4",
            "width": WIDTH,
            "height": height,
            "padding": PADDING,
            "projection": {
                "type": "mercator",
                "minX": min_x,
                "maxX": max_x,
                "minY": min_y,
                "maxY": max_y,
                "scale": scale,
                "yOffset": y_offset,
            },
            "provinceCount": len(provinces),
            "cityCount": len(cities),
            "roadCount": len(road_paths),
        },
        "provinces": provinces,
        "cityPaths": city_paths,
        "cities": cities,
        "roads": road_paths,
    }
    PUBLIC_PATH.parent.mkdir(parents=True, exist_ok=True)
    PUBLIC_PATH.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {PUBLIC_PATH} ({len(provinces)} provinces, {len(cities)} cities, {len(road_paths)} roads)")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
