from __future__ import annotations

import json
import math
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / "data" / "source" / "geojson-cn"
PUBLIC_PATH = ROOT / "public" / "data" / "china-boundaries.json"
BASE_URL = "https://geojson.cn/api/china"


def fetch_json(filename: str) -> dict[str, Any]:
    SOURCE_DIR.mkdir(parents=True, exist_ok=True)
    path = SOURCE_DIR / f"{filename.replace('/', '_')}.json"
    if not path.exists() or path.stat().st_size < 1000:
        url = f"{BASE_URL}/{filename}.json"
        with urllib.request.urlopen(url, timeout=40) as response:
            path.write_bytes(response.read())
    return json.loads(path.read_text(encoding="utf-8"))


def point_line_distance(point: list[float], start: list[float], end: list[float]) -> float:
    if start == end:
        return math.hypot(point[0] - start[0], point[1] - start[1])
    x, y = point
    x1, y1 = start
    x2, y2 = end
    dx = x2 - x1
    dy = y2 - y1
    t = max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)))
    proj_x = x1 + t * dx
    proj_y = y1 + t * dy
    return math.hypot(x - proj_x, y - proj_y)


def simplify_ring(points: list[list[float]], tolerance: float) -> list[list[float]]:
    if len(points) <= 3:
        return points

    def rdp(segment: list[list[float]]) -> list[list[float]]:
        if len(segment) <= 2:
            return segment
        start = segment[0]
        end = segment[-1]
        index = 0
        max_distance = 0.0
        for i in range(1, len(segment) - 1):
            distance = point_line_distance(segment[i], start, end)
            if distance > max_distance:
                index = i
                max_distance = distance
        if max_distance > tolerance:
            left = rdp(segment[: index + 1])
            right = rdp(segment[index:])
            return left[:-1] + right
        return [start, end]

    closed = points[0] == points[-1]
    work = points[:-1] if closed else points
    simplified = rdp(work)
    if closed and simplified[0] != simplified[-1]:
        simplified.append(simplified[0])
    return [[round(point[0], 4), round(point[1], 4)] for point in simplified]


def extract_lines(feature: dict[str, Any], tolerance: float) -> list[list[list[float]]]:
    geometry = feature.get("geometry") or {}
    kind = geometry.get("type")
    coordinates = geometry.get("coordinates") or []
    polygons = coordinates if kind == "MultiPolygon" else [coordinates] if kind == "Polygon" else []
    lines: list[list[list[float]]] = []
    for polygon in polygons:
        for ring in polygon:
            simplified = simplify_ring(ring, tolerance)
            if len(simplified) >= 3:
                lines.append(simplified)
    return lines


def main() -> None:
    country = fetch_json("100000")
    province_lines: list[list[list[float]]] = []
    city_lines: list[list[list[float]]] = []

    province_features = country["features"]
    for province in province_features:
        province_lines.extend(extract_lines(province, tolerance=0.025))

    for index, province in enumerate(province_features, start=1):
        filename = province["properties"].get("filename")
        if not filename:
            continue
        province_geojson = fetch_json(filename)
        for city in province_geojson.get("features", []):
            city_lines.extend(extract_lines(city, tolerance=0.055))
        print(f"{index:02d}/{len(province_features)} {province['properties'].get('fullname')}")

    payload = {
        "metadata": {
            "source": "GeoJSON.CN",
            "sourceUrl": "https://geojson.cn/data/atlas/china",
            "provinceLineCount": len(province_lines),
            "cityLineCount": len(city_lines),
            "note": "Simplified boundaries for lightweight globe rendering.",
        },
        "provinceLines": province_lines,
        "cityLines": city_lines,
    }
    PUBLIC_PATH.parent.mkdir(parents=True, exist_ok=True)
    PUBLIC_PATH.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {PUBLIC_PATH}")


if __name__ == "__main__":
    main()
