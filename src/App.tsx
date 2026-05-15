import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from "react";
import { Building2, Database, FileText, Layers3, ListFilter, Loader2, LocateFixed, MapPin, Moon, Search, Sun } from "lucide-react";
import type { ChinaMapDataset, CoordinateMode, Coord, MapPoint, ProjectDataset, ProjectRecord, ThemeMode } from "./types";

const PROVINCE_COLORS = [
  "#d8eee7",
  "#f6dfb3",
  "#d9e7fb",
  "#eadcf8",
  "#ccece2",
  "#f7d8c7",
  "#dbe8c3",
  "#f1d4dd",
  "#cfe8ef",
  "#f6e7af",
];

const NIGHT_PROVINCE_COLORS = [
  "#123c3a",
  "#45351a",
  "#172f53",
  "#32264e",
  "#154436",
  "#4a2a1d",
  "#28391e",
  "#412536",
  "#183c49",
  "#443b17",
];

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "");
}

function normalizeProvinceName(value: string): string {
  return value
    .replace(/特别行政区$/g, "")
    .replace(/自治区$/g, "")
    .replace(/省$|市$/g, "")
    .replace(/壮族|回族|维吾尔/g, "");
}

function coordFor(project: ProjectRecord, mode: CoordinateMode): Coord | null {
  if (mode === "address" && project.addressCoord) return project.addressCoord;
  return project.cityCoord ?? project.addressCoord;
}

function mercator(lng: number, lat: number): { x: number; y: number } {
  const clampedLat = Math.max(-85, Math.min(85, lat));
  return {
    x: (lng * Math.PI) / 180,
    y: Math.log(Math.tan(Math.PI / 4 + (clampedLat * Math.PI) / 360)),
  };
}

function projectCoord(coord: Coord, mapData: ChinaMapDataset): { x: number; y: number } {
  const projection = mapData.metadata.projection;
  const point = mercator(coord.lng, coord.lat);
  return {
    x: mapData.metadata.padding + (point.x - projection.minX) * projection.scale,
    y: projection.yOffset + (projection.maxY - point.y) * projection.scale,
  };
}

function buildCityPoints(projects: ProjectRecord[], mapData: ChinaMapDataset): MapPoint[] {
  const groups = new Map<string, MapPoint>();
  for (const project of projects) {
    if (!project.cityCoord) continue;
    const key = `${project.province}|${project.displayCity}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      existing.projectIds.push(project.id);
      continue;
    }
    const point = projectCoord(project.cityCoord, mapData);
    groups.set(key, {
      id: key,
      type: "city",
      label: project.displayCityLabel || project.displayCity,
      sublabel: `${project.province} · ${project.displayCity}`,
      count: 1,
      lng: point.x,
      lat: point.y,
      projectId: project.id,
      projectIds: [project.id],
    });
  }
  return Array.from(groups.values()).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "zh-CN"));
}

function buildProjectPoints(projects: ProjectRecord[], mode: CoordinateMode, mapData: ChinaMapDataset): MapPoint[] {
  const seen = new Map<string, number>();
  const points: MapPoint[] = [];
  for (const project of projects) {
    const coord = coordFor(project, mode);
    if (!coord) continue;
    const projected = projectCoord(coord, mapData);
    const coordKey = `${projected.x.toFixed(2)}|${projected.y.toFixed(2)}`;
    const index = seen.get(coordKey) ?? 0;
    seen.set(coordKey, index + 1);
    const angle = ((project.id * 137.508 + index * 31) % 360) * (Math.PI / 180);
    const radius = mode === "address" ? Math.min(10, index * 2.2) : 0;
    points.push({
      id: `project-${project.id}`,
      type: "project",
      label: project.company,
      sublabel: `${project.displayCityLabel || project.displayCity} · ${project.district || "地级行政区"}`,
      count: 1,
      lng: projected.x + Math.cos(angle) * radius,
      lat: projected.y + Math.sin(angle) * radius,
      projectId: project.id,
      projectIds: [project.id],
    });
  }
  return points;
}

function projectMatches(project: ProjectRecord, query: string): boolean {
  const tokens = query.trim().split(/\s+/).filter(Boolean).map(normalizeText);
  if (!tokens.length) return true;
  const haystack = normalizeText(
    [
      project.company,
      project.companyRaw,
      project.address,
      project.addressRaw,
      project.province,
      project.displayCity,
      project.displayCityLabel,
      project.district,
      project.region,
    ].join(" "),
  );
  return tokens.every((token) => haystack.includes(token));
}

function clampViewBox(viewBox: MapViewBox, full: MapViewBox): MapViewBox {
  const width = Math.min(full.width, Math.max(115, viewBox.width));
  const height = Math.min(full.height, Math.max(95, viewBox.height));
  return {
    x: Math.max(full.x, Math.min(full.x + full.width - width, viewBox.x)),
    y: Math.max(full.y, Math.min(full.y + full.height - height, viewBox.y)),
    width,
    height,
  };
}

function interpolateViewBox(from: MapViewBox, to: MapViewBox, value: number): MapViewBox {
  return {
    x: from.x + (to.x - from.x) * value,
    y: from.y + (to.y - from.y) * value,
    width: from.width + (to.width - from.width) * value,
    height: from.height + (to.height - from.height) * value,
  };
}

function easeInOutCubic(value: number): number {
  return value < 0.5 ? 4 * value * value * value : 1 - Math.pow(-2 * value + 2, 3) / 2;
}

interface MapViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ScreenPoint {
  x: number;
  y: number;
}

interface MapLabel {
  id: string;
  kind: "province" | "city" | "company";
  text: string;
  x: number;
  y: number;
  priority: number;
  projectId?: number;
  active?: boolean;
}

interface RoadSegment {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function boxesOverlap(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function ChinaMapCanvas({
  projects,
  selectedProject,
  coordinateMode,
  theme,
  mapData,
  onSelectProject,
}: {
  projects: ProjectRecord[];
  selectedProject: ProjectRecord | null;
  coordinateMode: CoordinateMode;
  theme: ThemeMode;
  mapData: ChinaMapDataset;
  onSelectProject: (projectId: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fullViewBox = useMemo<MapViewBox>(
    () => ({ x: 0, y: 0, width: mapData.metadata.width, height: mapData.metadata.height }),
    [mapData],
  );
  const [viewBox, setViewBox] = useState<MapViewBox>(fullViewBox);
  const [viewportSize, setViewportSize] = useState({ width: 1, height: 1 });
  const viewBoxRef = useRef(viewBox);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const gestureRef = useRef<{
    mode: "none" | "pan" | "pinch";
    startX: number;
    startY: number;
    startViewBox: MapViewBox;
    startDistance: number;
    startCenter: ScreenPoint;
    moved: boolean;
  }>({
    mode: "none",
    startX: 0,
    startY: 0,
    startViewBox: fullViewBox,
    startDistance: 0,
    startCenter: { x: 0, y: 0 },
    moved: false,
  });

  useEffect(() => {
    viewBoxRef.current = viewBox;
  }, [viewBox]);

  useEffect(() => {
    setViewBox(fullViewBox);
  }, [fullViewBox]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const update = () => {
      const rect = container.getBoundingClientRect();
      setViewportSize({ width: Math.max(1, rect.width), height: Math.max(1, rect.height) });
    };
    const observer = new ResizeObserver(update);
    observer.observe(container);
    update();
    return () => observer.disconnect();
  }, []);

  const points = useMemo(() => {
    return coordinateMode === "city" ? buildCityPoints(projects, mapData) : buildProjectPoints(projects, coordinateMode, mapData);
  }, [coordinateMode, mapData, projects]);

  const selectedPoint = useMemo(() => {
    if (!selectedProject) return null;
    const coord = coordFor(selectedProject, coordinateMode);
    if (!coord) return null;
    return projectCoord(coord, mapData);
  }, [coordinateMode, mapData, selectedProject]);

  const provinceNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const project of projects) {
      const province = normalizeProvinceName(project.province);
      counts.set(province, (counts.get(province) ?? 0) + 1);
    }
    return counts;
  }, [projects]);

  const projectCityNames = useMemo(() => {
    const names = new Set<string>();
    for (const project of projects) {
      const province = normalizeProvinceName(project.province);
      names.add(`${province}|${project.displayCity}`);
      names.add(`${province}|${project.displayCityLabel}`);
    }
    return names;
  }, [projects]);

  const scale = fullViewBox.width / viewBox.width;
  const pxPerMapUnit = viewportSize.width / viewBox.width;
  const provinceFill = theme === "night" ? NIGHT_PROVINCE_COLORS : PROVINCE_COLORS;
  const activeProvince = selectedProject ? normalizeProvinceName(selectedProject.province) : null;

  const mapToScreen = useCallback(
    (x: number, y: number): ScreenPoint => ({
      x: ((x - viewBox.x) / viewBox.width) * viewportSize.width,
      y: ((y - viewBox.y) / viewBox.height) * viewportSize.height,
    }),
    [viewBox, viewportSize],
  );

  const screenToMap = useCallback(
    (x: number, y: number, sourceViewBox = viewBoxRef.current): ScreenPoint => ({
      x: sourceViewBox.x + (x / viewportSize.width) * sourceViewBox.width,
      y: sourceViewBox.y + (y / viewportSize.height) * sourceViewBox.height,
    }),
    [viewportSize],
  );

  const animateTo = useCallback(
    (target: MapViewBox, duration = 780) => {
      const from = viewBoxRef.current;
      const to = clampViewBox(target, fullViewBox);
      const start = performance.now();
      const frame = (now: number) => {
        const progress = Math.min(1, (now - start) / duration);
        const eased = easeInOutCubic(progress);
        const next = interpolateViewBox(from, to, eased);
        viewBoxRef.current = next;
        setViewBox(next);
        if (progress < 1) requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    },
    [fullViewBox],
  );

  const setClampedViewBox = useCallback(
    (next: MapViewBox) => {
      const clamped = clampViewBox(next, fullViewBox);
      viewBoxRef.current = clamped;
      setViewBox(clamped);
    },
    [fullViewBox],
  );

  const zoomAt = useCallback(
    (factor: number, screenX: number, screenY: number, duration = 0) => {
      const current = viewBoxRef.current;
      const mapPoint = screenToMap(screenX, screenY, current);
      const nextWidth = current.width * factor;
      const nextHeight = current.height * factor;
      const target = {
        x: mapPoint.x - (screenX / viewportSize.width) * nextWidth,
        y: mapPoint.y - (screenY / viewportSize.height) * nextHeight,
        width: nextWidth,
        height: nextHeight,
      };
      if (duration) {
        animateTo(target, duration);
      } else {
        setClampedViewBox(target);
      }
    },
    [animateTo, screenToMap, setClampedViewBox, viewportSize],
  );

  useEffect(() => {
    if (!selectedPoint) return;
    const targetWidth = coordinateMode === "city" ? 230 : 170;
    const targetHeight = targetWidth * (fullViewBox.height / fullViewBox.width);
    animateTo(
      {
        x: selectedPoint.x - targetWidth / 2,
        y: selectedPoint.y - targetHeight / 2,
        width: targetWidth,
        height: targetHeight,
      },
      980,
    );
  }, [animateTo, coordinateMode, fullViewBox, selectedPoint]);

  const zoom = useCallback(
    (factor: number) => {
      zoomAt(factor, viewportSize.width / 2, viewportSize.height / 2, 260);
    },
    [viewportSize, zoomAt],
  );

  const roadSegments = useMemo<RoadSegment[]>(() => {
    const projectCities = mapData.cities.filter(
      (city) => projectCityNames.has(`${city.province}|${city.name}`) || projectCityNames.has(`${city.province}|${city.fullname}`),
    );
    const segments = new Map<string, RoadSegment>();
    for (const city of projectCities) {
      const neighbors = projectCities
        .filter((candidate) => candidate !== city && candidate.province === city.province)
        .map((candidate) => ({ city: candidate, distance: distance(city, candidate) }))
        .filter((item) => item.distance < 120)
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 2);
      for (const neighbor of neighbors) {
        const key = [city.fullname, neighbor.city.fullname].sort().join("|");
        if (!segments.has(key)) {
          segments.set(key, {
            id: key,
            x1: city.x,
            y1: city.y,
            x2: neighbor.city.x,
            y2: neighbor.city.y,
          });
        }
      }
    }
    return Array.from(segments.values());
  }, [mapData.cities, projectCityNames]);

  const nearbyProjects = useMemo(() => {
    if (!selectedPoint || !selectedProject) return [];
    return projects
      .map((project) => {
        const coord = coordFor(project, coordinateMode);
        if (!coord) return null;
        const point = projectCoord(coord, mapData);
        return { project, point, distance: distance(point, selectedPoint) };
      })
      .filter((item): item is { project: ProjectRecord; point: ScreenPoint; distance: number } => Boolean(item))
      .sort((a, b) => {
        const aSelected = a.project.id === selectedProject.id ? 1 : 0;
        const bSelected = b.project.id === selectedProject.id ? 1 : 0;
        return bSelected - aSelected || a.distance - b.distance;
      })
      .slice(0, 18);
  }, [coordinateMode, mapData, projects, selectedPoint, selectedProject]);

  const overlayLabels = useMemo<MapLabel[]>(() => {
    const candidates: MapLabel[] = [];
    for (const province of mapData.provinces) {
      if (!provinceNames.has(province.name)) continue;
      if (scale < 1.85 || province.name === activeProvince) {
        candidates.push({
          id: `province-${province.code}`,
          kind: "province",
          text: province.name,
          x: province.label.x,
          y: province.label.y,
          priority: province.name === activeProvince ? 1000 : 600 + (provinceNames.get(province.name) ?? 0),
          active: province.name === activeProvince,
        });
      }
    }

    if (scale >= 1.85) {
      const cityLimit = scale < 2.6 ? 32 : scale < 4 ? 80 : 130;
      const cityCandidates = points
        .filter((point) => point.type === "city")
        .sort((a, b) => {
          const aActive = selectedProject && a.projectIds.includes(selectedProject.id) ? 1 : 0;
          const bActive = selectedProject && b.projectIds.includes(selectedProject.id) ? 1 : 0;
          return bActive - aActive || b.count - a.count;
        })
        .slice(0, cityLimit);
      for (const point of cityCandidates) {
        candidates.push({
          id: `city-${point.id}`,
          kind: "city",
          text: point.label,
          x: point.lng,
          y: point.lat,
          priority: 360 + point.count,
          active: selectedProject ? point.projectIds.includes(selectedProject.id) : false,
        });
      }
    }

    if (selectedProject && scale >= 2.2) {
      for (const item of nearbyProjects) {
        candidates.push({
          id: `company-${item.project.id}`,
          kind: "company",
          text: item.project.company,
          x: item.point.x,
          y: item.point.y,
          priority: item.project.id === selectedProject.id ? 2000 : 900 - item.distance,
          active: item.project.id === selectedProject.id,
          projectId: item.project.id,
        });
      }
    }

    const placed: Array<{ x: number; y: number; width: number; height: number }> = [];
    return candidates
      .map((label) => ({ label, screen: mapToScreen(label.x, label.y) }))
      .filter(({ screen }) => screen.x > -90 && screen.y > -40 && screen.x < viewportSize.width + 90 && screen.y < viewportSize.height + 40)
      .sort((a, b) => b.label.priority - a.label.priority)
      .filter(({ label, screen }) => {
        const width = label.kind === "company" ? Math.min(190, Math.max(88, label.text.length * 12)) : label.kind === "province" ? 52 : 46;
        const height = label.kind === "company" ? 32 : 24;
        const box = { x: screen.x - width / 2, y: screen.y - height / 2, width, height };
        if (!label.active && placed.some((item) => boxesOverlap(box, item))) return false;
        placed.push(box);
        return true;
      })
      .map(({ label }) => label);
  }, [activeProvince, mapData.provinces, mapToScreen, nearbyProjects, points, provinceNames, scale, selectedProject, viewportSize]);

  const onWheel = useCallback(
    (event: ReactWheelEvent<SVGSVGElement>) => {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      const factor = Math.exp(event.deltaY * 0.0012);
      zoomAt(factor, event.clientX - rect.left, event.clientY - rect.top);
    },
    [zoomAt],
  );

  const onPointerDown = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const pointers = Array.from(pointersRef.current.values());
    if (pointers.length >= 2) {
      const [a, b] = pointers;
      gestureRef.current = {
        mode: "pinch",
        startX: 0,
        startY: 0,
        startViewBox: viewBoxRef.current,
        startDistance: distance(a, b),
        startCenter: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        moved: false,
      };
    } else {
      gestureRef.current = {
        mode: "pan",
        startX: event.clientX,
        startY: event.clientY,
        startViewBox: viewBoxRef.current,
        startDistance: 0,
        startCenter: { x: event.clientX, y: event.clientY },
        moved: false,
      };
    }
  }, []);

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      if (!pointersRef.current.has(event.pointerId)) return;
      pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const gesture = gestureRef.current;
      const rect = event.currentTarget.getBoundingClientRect();
      if (gesture.mode === "pinch") {
        const pointers = Array.from(pointersRef.current.values());
        if (pointers.length < 2 || !gesture.startDistance) return;
        const [a, b] = pointers;
        const currentDistance = distance(a, b);
        const center = { x: (a.x + b.x) / 2 - rect.left, y: (a.y + b.y) / 2 - rect.top };
        const startCenter = { x: gesture.startCenter.x - rect.left, y: gesture.startCenter.y - rect.top };
        const factor = gesture.startDistance / Math.max(20, currentDistance);
        const anchor = screenToMap(startCenter.x, startCenter.y, gesture.startViewBox);
        const nextWidth = gesture.startViewBox.width * factor;
        const nextHeight = gesture.startViewBox.height * factor;
        setClampedViewBox({
          x: anchor.x - (center.x / viewportSize.width) * nextWidth,
          y: anchor.y - (center.y / viewportSize.height) * nextHeight,
          width: nextWidth,
          height: nextHeight,
        });
        gesture.moved = true;
      } else if (gesture.mode === "pan") {
        const dx = event.clientX - gesture.startX;
        const dy = event.clientY - gesture.startY;
        if (Math.hypot(dx, dy) > 3) gesture.moved = true;
        setClampedViewBox({
          ...gesture.startViewBox,
          x: gesture.startViewBox.x - (dx / viewportSize.width) * gesture.startViewBox.width,
          y: gesture.startViewBox.y - (dy / viewportSize.height) * gesture.startViewBox.height,
        });
      }
    },
    [screenToMap, setClampedViewBox, viewportSize],
  );

  const onPointerUp = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    pointersRef.current.delete(event.pointerId);
    if (pointersRef.current.size === 0) {
      setTimeout(() => {
        gestureRef.current.moved = false;
      }, 0);
      gestureRef.current.mode = "none";
    }
  }, []);

  return (
    <div className="map-canvas" ref={containerRef}>
      <svg
        className="china-map"
        viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
        role="img"
        aria-label="中国认证项目分布线框图"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <defs>
          <filter id="selectedGlow" x="-70%" y="-70%" width="240%" height="240%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <rect className="map-water" x="0" y="0" width={fullViewBox.width} height={fullViewBox.height} />
        <g className="province-fills">
          {mapData.provinces.map((province) => (
            <path
              key={province.code}
              className={`province-area ${province.name === activeProvince ? "is-active" : ""}`}
              d={province.path}
              fill={provinceFill[province.colorIndex % provinceFill.length]}
            />
          ))}
        </g>
        <g className="city-boundaries">
          {mapData.cityPaths.map((city, index) => (
            <path key={`${city.province}-${city.name}-${index}`} d={city.path} />
          ))}
        </g>
        <g className="road-lines">
          {roadSegments.map((segment) => (
            <line key={segment.id} x1={segment.x1} y1={segment.y1} x2={segment.x2} y2={segment.y2} />
          ))}
        </g>
        <g className="town-dots">
          {scale >= 1.35 &&
            mapData.cities.map((city, index) => (
              <circle key={`${city.province}-${city.name}-town-${index}`} cx={city.x} cy={city.y} r={Math.max(0.9, 1.7 / pxPerMapUnit)} />
            ))}
        </g>
        <g className="province-boundaries">
          {mapData.provinces.map((province) => (
            <path key={`${province.code}-line`} d={province.path} />
          ))}
        </g>
        <g className="project-points">
          {points.map((point) => {
            const active = selectedProject ? point.projectIds.includes(selectedProject.id) : false;
            const radiusPx = active ? 7 : coordinateMode === "city" ? Math.min(6, 2.8 + point.count * 0.3) : 3.4;
            return (
              <g
                key={point.id}
                className="point-hit"
                role="button"
                tabIndex={0}
                aria-label={point.label}
                onClick={() => {
                  if (!gestureRef.current.moved) onSelectProject(point.projectId);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") onSelectProject(point.projectId);
                }}
              >
                <circle className={`project-dot ${active ? "is-active" : ""}`} cx={point.lng} cy={point.lat} r={radiusPx / pxPerMapUnit} />
              </g>
            );
          })}
        </g>
      </svg>

      <div className="map-label-layer" aria-hidden="true">
        {overlayLabels.map((label) => {
          const screen = mapToScreen(label.x, label.y);
          return (
            <button
              key={label.id}
              className={`map-label is-${label.kind} ${label.active ? "is-active" : ""}`}
              type="button"
              style={{ transform: `translate(${screen.x}px, ${screen.y}px) translate(-50%, -50%)` }}
              onClick={() => label.projectId && onSelectProject(label.projectId)}
              tabIndex={-1}
            >
              {label.text}
            </button>
          );
        })}
      </div>

      {selectedPoint && (
        <div
          className="target-pulse"
          style={{
            transform: `translate(${mapToScreen(selectedPoint.x, selectedPoint.y).x}px, ${mapToScreen(selectedPoint.x, selectedPoint.y).y}px) translate(-50%, -50%)`,
          }}
        >
          <span />
          <span />
          <span />
        </div>
      )}

      <div className="map-controls" aria-label="地图缩放">
        <button type="button" onClick={() => zoom(0.66)} aria-label="放大地图">
          +
        </button>
        <button type="button" onClick={() => zoom(1.45)} aria-label="缩小地图">
          -
        </button>
        <button type="button" onClick={() => animateTo(fullViewBox, 420)} aria-label="显示全国">
          全国
        </button>
      </div>
    </div>
  );
}

function EmptyState({ query }: { query: string }) {
  return (
    <div className="empty-state">
      <Search size={26} />
      <strong>没有匹配结果</strong>
      <span>{query}</span>
    </div>
  );
}

export default function App() {
  const [dataset, setDataset] = useState<ProjectDataset | null>(null);
  const [mapData, setMapData] = useState<ChinaMapDataset | null>(null);
  const [query, setQuery] = useState("");
  const [coordinateMode, setCoordinateMode] = useState<CoordinateMode>("city");
  const [theme, setTheme] = useState<ThemeMode>("day");
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      fetch(`${import.meta.env.BASE_URL}data/projects.json`).then((response) => {
        if (!response.ok) throw new Error(`项目数据加载失败：${response.status}`);
        return response.json() as Promise<ProjectDataset>;
      }),
      fetch(`${import.meta.env.BASE_URL}data/china-map.json`).then((response) => {
        if (!response.ok) throw new Error(`地图数据加载失败：${response.status}`);
        return response.json() as Promise<ChinaMapDataset>;
      }),
    ])
      .then(([projects, map]) => {
        setDataset(projects);
        setMapData(map);
      })
      .catch((error: unknown) => {
        setLoadError(error instanceof Error ? error.message : String(error));
      });
  }, []);

  const filteredProjects = useMemo(() => {
    if (!dataset) return [];
    return dataset.projects.filter((project) => projectMatches(project, query));
  }, [dataset, query]);

  const visibleProjects = query.trim() ? filteredProjects : dataset?.projects ?? [];

  const selectedProject = useMemo(() => {
    if (!dataset || !selectedProjectId) return null;
    return dataset.projects.find((project) => project.id === selectedProjectId) ?? null;
  }, [dataset, selectedProjectId]);

  useEffect(() => {
    if (!query.trim() || !filteredProjects.length) return;
    setSelectedProjectId((current) => {
      if (current && filteredProjects.some((project) => project.id === current)) return current;
      return filteredProjects[0].id;
    });
  }, [filteredProjects, query]);

  const onSelectProject = useCallback((projectId: number) => {
    setSelectedProjectId(projectId);
  }, []);

  const clearSearch = useCallback(() => {
    setQuery("");
    setSelectedProjectId(null);
  }, []);

  if (loadError) {
    return (
      <main className="loading-page">
        <Database size={32} />
        <strong>数据加载失败</strong>
        <span>{loadError}</span>
      </main>
    );
  }

  if (!dataset || !mapData) {
    return (
      <main className="loading-page">
        <Loader2 className="spin" size={32} />
        <strong>正在加载本地地图数据库</strong>
      </main>
    );
  }

  const districtCount = dataset.metadata.matchMethods.district ?? 0;
  const prefectureCount = dataset.metadata.matchMethods.prefecture ?? 0;

  return (
    <main className={`app-shell theme-${theme}`}>
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <MapPin size={22} />
          </div>
          <div>
            <h1>认证项目多场所地图</h1>
            <p>{dataset.metadata.sourceTitle}</p>
          </div>
        </div>

        <div className="stat-strip" aria-label="数据概览">
          <div>
            <strong>{dataset.metadata.extractedProjects}</strong>
            <span>项目</span>
          </div>
          <div>
            <strong>{dataset.metadata.uniquePlaces}</strong>
            <span>地点</span>
          </div>
          <div>
            <strong>{districtCount}</strong>
            <span>区县级</span>
          </div>
          <div>
            <strong>{prefectureCount}</strong>
            <span>地级</span>
          </div>
        </div>

        <button
          className="theme-toggle"
          type="button"
          onClick={() => setTheme((current) => (current === "day" ? "night" : "day"))}
          aria-label="切换日夜模式"
        >
          {theme === "day" ? <Sun size={16} /> : <Moon size={16} />}
          {theme === "day" ? "日间" : "黑夜"}
        </button>
      </header>

      <section className="workspace">
        <section className="visual-pane">
          <div className="toolbar">
            <div className="search-box">
              <Search size={18} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索公司、城市、地址"
                aria-label="搜索公司、城市、地址"
              />
              {query && (
                <button className="ghost-button" type="button" onClick={clearSearch}>
                  清除
                </button>
              )}
            </div>

            <div className="map-mode-note">
              <MapPin size={16} />
              本地线框地图
            </div>

            <div className="segmented" aria-label="坐标模式">
              <button className={coordinateMode === "city" ? "is-active" : ""} type="button" onClick={() => setCoordinateMode("city")}>
                <Layers3 size={16} />
                地级市
              </button>
              <button className={coordinateMode === "address" ? "is-active" : ""} type="button" onClick={() => setCoordinateMode("address")}>
                <LocateFixed size={16} />
                精确地址
              </button>
            </div>
          </div>

          <div className="stage">
            <ChinaMapCanvas
              projects={visibleProjects}
              selectedProject={selectedProject}
              coordinateMode={coordinateMode}
              theme={theme}
              mapData={mapData}
              onSelectProject={onSelectProject}
            />
            {selectedProject && (
              <div className="focus-card">
                <span>{selectedProject.displayCityLabel || selectedProject.displayCity}</span>
                <strong>{selectedProject.company}</strong>
                <p>{selectedProject.address}</p>
              </div>
            )}
          </div>
        </section>

        <aside className="side-panel">
          <div className="panel-head">
            <div>
              <span className="eyebrow">
                <ListFilter size={14} />
                项目清单
              </span>
              <h2>{visibleProjects.length} 条记录</h2>
            </div>
            <div className="db-badge">
              <Database size={14} />
              本地数据
            </div>
          </div>

          <div className="selection-summary">
            <FileText size={16} />
            <span>{query.trim() ? "搜索结果" : "全部项目"}</span>
            <strong>{visibleProjects.length}</strong>
          </div>

          <div className="project-list">
            {visibleProjects.length ? (
              visibleProjects.map((project) => (
                <button
                  className={`project-row ${project.id === selectedProject?.id ? "is-active" : ""}`}
                  type="button"
                  key={project.id}
                  onClick={() => onSelectProject(project.id)}
                >
                  <span className="row-top">
                    <span className="row-index">{String(project.id).padStart(3, "0")}</span>
                    <span className="row-place">
                      {project.displayCityLabel || project.displayCity}
                      {project.district ? ` · ${project.district}` : ""}
                    </span>
                  </span>
                  <strong>
                    <Building2 size={15} />
                    {project.company}
                  </strong>
                  <span className="row-address">{project.address}</span>
                </button>
              ))
            ) : (
              <EmptyState query={query} />
            )}
          </div>

          <div className="coordinate-note">{dataset.metadata.coordinateNote}</div>
        </aside>
      </section>
    </main>
  );
}
