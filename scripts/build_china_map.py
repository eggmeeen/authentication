from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / "data" / "source" / "geojson-cn"
PROJECTS_PATH = ROOT / "public" / "data" / "projects.json"
PUBLIC_PATH = ROOT / "public" / "data" / "china-map.json"

WIDTH = 1000
PADDING = 28


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


def main() -> None:
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

    provinces: list[dict[str, Any]] = []
    cities: list[dict[str, Any]] = []
    city_paths: list[dict[str, Any]] = []

    for index, feature in enumerate(country["features"]):
        properties = feature["properties"]
        if "code" not in properties:
            continue
        name = properties["name"]
        fullname = properties.get("fullname", name)
        center = properties.get("center") or [0, 0]
        # Keep enough geometry for close zooms. The previous tolerances were tuned
        # for a thumbnail-sized map and produced visibly angular borders.
        path = " ".join(filter(None, (ring_to_path(ring, 0.18) for ring in geometry_rings(feature))))
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
            city_path = " ".join(filter(None, (ring_to_path(ring, 0.32) for ring in geometry_rings(city))))
            if city_path:
                city_paths.append({"province": name, "name": city_props["name"], "path": city_path})

    payload = {
        "metadata": {
            "source": "GeoJSON.CN",
            "sourceUrl": "https://geojson.cn/data/atlas/china",
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
        },
        "provinces": provinces,
        "cityPaths": city_paths,
        "cities": cities,
    }
    PUBLIC_PATH.parent.mkdir(parents=True, exist_ok=True)
    PUBLIC_PATH.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {PUBLIC_PATH} ({len(provinces)} provinces, {len(cities)} cities)")


if __name__ == "__main__":
    main()
