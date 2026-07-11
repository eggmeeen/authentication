import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { Building2, ChevronDown, ChevronUp, CircleHelp, Database, FileText, Layers3, ListFilter, Loader2, LocateFixed, MapPin, Minus, MousePointer2, Plus, RotateCcw, Search, Sun, Moon, X } from "lucide-react";
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

const MIN_VIEWBOX_WIDTH = 76;
const MIN_VIEWBOX_HEIGHT = 62;

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

function companyCode(project: ProjectRecord): string {
  return String(project.id).padStart(3, "0");
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
      provinceName: normalizeProvinceName(project.province),
      count: 1,
      lng: point.x,
      lat: point.y,
      projectId: project.id,
      projectIds: [project.id],
    });
  }
  return Array.from(groups.values()).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "zh-CN"));
}

function projectMatches(project: ProjectRecord, query: string): boolean {
  const tokens = query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(normalizeText);
  if (!tokens.length) return true;
  const haystack = normalizeText(
    [
      project.company,
      project.companyRaw,
      project.address,
      project.addressRaw,
      companyCode(project),
      String(project.id),
      project.sequence,
      project.province,
      project.displayCity,
      project.displayCityLabel,
      project.district,
      project.region,
    ].join(" "),
  );
  return tokens.every((token) => {
    if (/^\d+$/.test(token)) {
      return companyCode(project).includes(token) || normalizeText(project.sequence).includes(token);
    }
    return haystack.includes(token);
  });
}

function clampViewBox(viewBox: MapViewBox, full: MapViewBox): MapViewBox {
  const width = Math.min(full.width, Math.max(MIN_VIEWBOX_WIDTH, viewBox.width));
  const height = Math.min(full.height, Math.max(MIN_VIEWBOX_HEIGHT, viewBox.height));
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

function stableLabelOffset(id: number, active = false): ScreenPoint {
  if (active) return { x: 76, y: -34 };
  const directions = [
    { x: 68, y: -28 },
    { x: -68, y: -28 },
    { x: 68, y: 28 },
    { x: -68, y: 28 },
    { x: 0, y: -46 },
    { x: 0, y: 46 },
  ];
  return directions[Math.abs(id * 2654435761) % directions.length];
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

interface ScreenViewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface BoundsBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface MapLabel {
  id: string;
  kind: "province" | "city" | "company";
  text: string;
  x: number;
  y: number;
  offsetX?: number;
  offsetY?: number;
  priority: number;
  projectId?: number;
  provinceName?: string;
  active?: boolean;
}

interface RoadSegment {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface ProjectHighlightPoint {
  id: number;
  x: number;
  y: number;
  selected: boolean;
}

interface ProjectConnection {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  kind: "same-province" | "adjacent-province";
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function boxesOverlap(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function pathBounds(path: string): BoundsBox | null {
  const values = path.match(/-?\d+(?:\.\d+)?/g);
  if (!values || values.length < 2) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < values.length - 1; index += 2) {
    const x = Number(values[index]);
    const y = Number(values[index + 1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) return null;
  return { minX, minY, maxX, maxY };
}

function boundsTouch(a: BoundsBox, b: BoundsBox, padding = 12): boolean {
  return !(
    a.maxX + padding < b.minX ||
    b.maxX + padding < a.minX ||
    a.maxY + padding < b.minY ||
    b.maxY + padding < a.minY
  );
}

function renderedViewport(sourceViewBox: MapViewBox, size: { width: number; height: number }): ScreenViewport {
  const viewRatio = sourceViewBox.width / sourceViewBox.height;
  const containerRatio = size.width / size.height;
  if (containerRatio > viewRatio) {
    const height = size.height;
    const width = height * viewRatio;
    return { x: (size.width - width) / 2, y: 0, width, height };
  }
  const width = size.width;
  const height = width / viewRatio;
  return { x: 0, y: (size.height - height) / 2, width, height };
}

function ChinaMapCanvas({
  projects,
  selectedProject,
  coordinateMode,
  theme,
  mapData,
  onSelectProject,
  onClearSelection,
}: {
  projects: ProjectRecord[];
  selectedProject: ProjectRecord | null;
  coordinateMode: CoordinateMode;
  theme: ThemeMode;
  mapData: ChinaMapDataset;
  onSelectProject: (projectId: number) => void;
  onClearSelection: () => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fullViewBox = useMemo<MapViewBox>(
    () => ({ x: 0, y: 0, width: mapData.metadata.width, height: mapData.metadata.height }),
    [mapData],
  );
  const [viewBox, setViewBox] = useState<MapViewBox>(fullViewBox);
  const [viewportSize, setViewportSize] = useState({ width: 1, height: 1 });
  const [selectedProvince, setSelectedProvince] = useState<string | null>(null);
  const [showMapHelp, setShowMapHelp] = useState(true);
  const viewBoxRef = useRef(viewBox);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const gestureScaleRef = useRef(1);
  const animationFrameRef = useRef<number | null>(null);
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

  const cityPoints = useMemo(() => buildCityPoints(projects, mapData), [mapData, projects]);

  const projectDisplayPoints = useMemo(() => {
    const seen = new Map<string, number>();
    const points = new Map<number, ScreenPoint>();
    for (const project of projects) {
      const coord = coordFor(project, coordinateMode);
      if (!coord) continue;
      const projected = projectCoord(coord, mapData);
      const province = normalizeProvinceName(project.province);
      const coordKey = `${province}|${projected.x.toFixed(2)}|${projected.y.toFixed(2)}`;
      const index = seen.get(coordKey) ?? 0;
      seen.set(coordKey, index + 1);
      const angle = ((project.id * 137.508 + index * 29) % 360) * (Math.PI / 180);
      const offsetRadius = Math.min(9, index * (coordinateMode === "address" ? 2.2 : 1.55));
      points.set(project.id, {
        x: projected.x + Math.cos(angle) * offsetRadius,
        y: projected.y + Math.sin(angle) * offsetRadius,
      });
    }
    return points;
  }, [coordinateMode, mapData, projects]);

  const selectedPoint = useMemo(() => {
    if (!selectedProject) return null;
    return projectDisplayPoints.get(selectedProject.id) ?? null;
  }, [projectDisplayPoints, selectedProject]);

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

  const currentScale = fullViewBox.width / viewBox.width;
  const labelScale = currentScale;
  const showProvinceCounts = currentScale <= 1.18;
  const mapViewport = useMemo(() => renderedViewport(viewBox, viewportSize), [viewBox, viewportSize]);
  const pxPerMapUnit = mapViewport.width / viewBox.width;
  const provinceFill = theme === "night" ? NIGHT_PROVINCE_COLORS : PROVINCE_COLORS;
  const activeProvince = selectedProvince ?? (selectedProject ? normalizeProvinceName(selectedProject.province) : null);

  const provinceCountLabels = useMemo(() => {
    if (!showProvinceCounts) return [];
    return mapData.provinces
      .map((province) => ({
        code: province.code,
        name: province.name,
        count: provinceNames.get(province.name) ?? 0,
        x: province.label.x,
        y: province.label.y,
      }))
      .filter((province) => province.count > 0);
  }, [mapData.provinces, provinceNames, showProvinceCounts]);

  const mapToScreen = useCallback(
    (x: number, y: number): ScreenPoint => ({
      x: mapViewport.x + ((x - viewBox.x) / viewBox.width) * mapViewport.width,
      y: mapViewport.y + ((y - viewBox.y) / viewBox.height) * mapViewport.height,
    }),
    [mapViewport, viewBox],
  );

  const visibleProvinceCountLabels = useMemo(() => {
    const placed: Array<{ x: number; y: number; width: number; height: number }> = [];
    return provinceCountLabels
      .map((province) => ({ ...province, screen: mapToScreen(province.x, province.y) }))
      .sort((a, b) => {
        const aActive = a.name === activeProvince ? 1 : 0;
        const bActive = b.name === activeProvince ? 1 : 0;
        return bActive - aActive || b.count - a.count;
      })
      .filter((province) => {
        const width = Math.max(42, Math.min(74, 30 + province.name.length * 10));
        const box = { x: province.screen.x - width / 2 - 3, y: province.screen.y - 14, width: width + 6, height: 28 };
        if (province.screen.x < 12 || province.screen.y < 12 || province.screen.x > viewportSize.width - 12 || province.screen.y > viewportSize.height - 12) return false;
        if (placed.some((item) => boxesOverlap(box, item)) && province.name !== activeProvince) return false;
        placed.push(box);
        return true;
      });
  }, [activeProvince, mapToScreen, provinceCountLabels, viewportSize]);

  const screenToMap = useCallback(
    (x: number, y: number, sourceViewBox = viewBoxRef.current): ScreenPoint => {
      const sourceViewport = renderedViewport(sourceViewBox, viewportSize);
      return {
        x: sourceViewBox.x + ((x - sourceViewport.x) / sourceViewport.width) * sourceViewBox.width,
        y: sourceViewBox.y + ((y - sourceViewport.y) / sourceViewport.height) * sourceViewBox.height,
      };
    },
    [viewportSize],
  );

  const cancelViewAnimation = useCallback(() => {
    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
  }, []);

  useEffect(() => cancelViewAnimation, [cancelViewAnimation]);

  const animateTo = useCallback(
    (target: MapViewBox, duration = 780) => {
      cancelViewAnimation();
      const from = viewBoxRef.current;
      const to = clampViewBox(target, fullViewBox);
      const start = performance.now();
      const frame = (now: number) => {
        const progress = Math.min(1, (now - start) / duration);
        const eased = easeInOutCubic(progress);
        const next = interpolateViewBox(from, to, eased);
        viewBoxRef.current = next;
        setViewBox(next);
        if (progress < 1) {
          animationFrameRef.current = requestAnimationFrame(frame);
        } else {
          animationFrameRef.current = null;
        }
      };
      animationFrameRef.current = requestAnimationFrame(frame);
    },
    [cancelViewAnimation, fullViewBox],
  );

  const setClampedViewBox = useCallback(
    (next: MapViewBox) => {
      cancelViewAnimation();
      const clamped = clampViewBox(next, fullViewBox);
      viewBoxRef.current = clamped;
      setViewBox(clamped);
    },
    [cancelViewAnimation, fullViewBox],
  );

  const zoomAt = useCallback(
    (factor: number, screenX: number, screenY: number, duration = 0) => {
      const current = viewBoxRef.current;
      const mapPoint = screenToMap(screenX, screenY, current);
      const currentViewport = renderedViewport(current, viewportSize);
      const anchorX = (screenX - currentViewport.x) / currentViewport.width;
      const anchorY = (screenY - currentViewport.y) / currentViewport.height;
      const nextWidth = current.width * factor;
      const nextHeight = current.height * factor;
      const target = {
        x: mapPoint.x - anchorX * nextWidth,
        y: mapPoint.y - anchorY * nextHeight,
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
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = container.getBoundingClientRect();
      const sensitivity = event.ctrlKey ? 0.006 : 0.0014;
      zoomAt(Math.exp(event.deltaY * sensitivity), event.clientX - rect.left, event.clientY - rect.top);
    };

    const handleGestureStart = (event: Event) => {
      event.preventDefault();
      gestureScaleRef.current = 1;
    };

    const handleGestureChange = (event: Event) => {
      event.preventDefault();
      const gesture = event as Event & { scale?: number; clientX?: number; clientY?: number };
      const nextScale = gesture.scale ?? 1;
      const deltaScale = nextScale / gestureScaleRef.current;
      gestureScaleRef.current = nextScale;
      const rect = container.getBoundingClientRect();
      zoomAt(1 / Math.max(0.25, Math.min(4, deltaScale)), (gesture.clientX ?? rect.left + rect.width / 2) - rect.left, (gesture.clientY ?? rect.top + rect.height / 2) - rect.top);
    };

    container.addEventListener("wheel", handleWheel, { passive: false });
    container.addEventListener("gesturestart", handleGestureStart, { passive: false });
    container.addEventListener("gesturechange", handleGestureChange, { passive: false });
    container.addEventListener("gestureend", handleGestureStart, { passive: false });
    return () => {
      container.removeEventListener("wheel", handleWheel);
      container.removeEventListener("gesturestart", handleGestureStart);
      container.removeEventListener("gesturechange", handleGestureChange);
      container.removeEventListener("gestureend", handleGestureStart);
    };
  }, [zoomAt]);

  useEffect(() => {
    if (!selectedPoint) {
      return;
    }
    setSelectedProvince(normalizeProvinceName(selectedProject?.province ?? ""));
    const current = viewBoxRef.current;
    const desiredScale = Math.min(6, Math.max(3.2, fullViewBox.width / current.width));
    const focusWidth = fullViewBox.width / desiredScale;
    const focusHeight = fullViewBox.height / desiredScale;
    const target = clampViewBox(
      {
        x: selectedPoint.x - focusWidth / 2,
        y: selectedPoint.y - focusHeight / 2,
        width: focusWidth,
        height: focusHeight,
      },
      fullViewBox,
    );
    animateTo(target, 520);
  }, [animateTo, fullViewBox, selectedPoint, selectedProject]);

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

  const provinceNeighbors = useMemo(() => {
    const projectProvinceSet = new Set(projects.map((project) => normalizeProvinceName(project.province)));
    const provinceEntries = mapData.provinces
      .filter((province) => projectProvinceSet.has(province.name))
      .map((province) => ({
        name: province.name,
        label: province.label,
        bounds: pathBounds(province.path),
      }))
      .filter((province): province is { name: string; label: { x: number; y: number }; bounds: BoundsBox } => Boolean(province.bounds));

    const neighbors = new Map<string, Array<{ name: string; distance: number }>>();
    for (const province of provinceEntries) {
      neighbors.set(province.name, []);
    }

    for (let index = 0; index < provinceEntries.length; index += 1) {
      for (let nextIndex = index + 1; nextIndex < provinceEntries.length; nextIndex += 1) {
        const a = provinceEntries[index];
        const b = provinceEntries[nextIndex];
        const labelDistance = distance(a.label, b.label);
        if (!boundsTouch(a.bounds, b.bounds, 16) || labelDistance > 320) continue;
        neighbors.get(a.name)?.push({ name: b.name, distance: labelDistance });
        neighbors.get(b.name)?.push({ name: a.name, distance: labelDistance });
      }
    }

    return new Map(
      Array.from(neighbors.entries()).map(([name, items]) => [
        name,
        items
          .sort((a, b) => a.distance - b.distance)
          .map((item) => item.name),
      ]),
    );
  }, [mapData.provinces, projects]);

  const provinceProjectHighlights = useMemo<ProjectHighlightPoint[]>(() => {
    if (!activeProvince) return [];
    return projects
      .filter((project) => normalizeProvinceName(project.province) === activeProvince)
      .map((project) => {
        const point = projectDisplayPoints.get(project.id);
        if (!point) return null;
        return {
          id: project.id,
          x: point.x,
          y: point.y,
          selected: selectedProject?.id === project.id,
        };
      })
      .filter((point): point is ProjectHighlightPoint => Boolean(point));
  }, [activeProvince, projectDisplayPoints, projects, selectedProject]);

  const provinceProjectConnections = useMemo<ProjectConnection[]>(() => {
    if (!selectedProject || !selectedPoint) return [];

    const connections: ProjectConnection[] = [];
    const selectedProvinceName = normalizeProvinceName(selectedProject.province);

    for (const point of provinceProjectHighlights) {
      if (point.id === selectedProject.id) continue;
      connections.push({
        id: `province-${selectedProject.id}-${point.id}`,
        x1: selectedPoint.x,
        y1: selectedPoint.y,
        x2: point.x,
        y2: point.y,
        kind: "same-province",
      });
    }

    const adjacentCandidates = (provinceNeighbors.get(selectedProvinceName) ?? [])
      .map((provinceName) => {
        const nearest = projects
          .filter((project) => normalizeProvinceName(project.province) === provinceName)
          .map((project) => {
            const point = projectDisplayPoints.get(project.id);
            if (!point) return null;
            return { projectId: project.id, point, distance: distance(point, selectedPoint) };
          })
          .filter((item): item is { projectId: number; point: ScreenPoint; distance: number } => Boolean(item))
          .sort((a, b) => a.distance - b.distance)[0];
        if (!nearest) return null;
        return {
          id: `adjacent-${selectedProject.id}-${nearest.projectId}`,
          x1: selectedPoint.x,
          y1: selectedPoint.y,
          x2: nearest.point.x,
          y2: nearest.point.y,
          kind: "adjacent-province" as const,
          distance: nearest.distance,
        };
      })
      .filter((item): item is { id: string; x1: number; y1: number; x2: number; y2: number; kind: "adjacent-province"; distance: number } => Boolean(item))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 6)
      .map(({ distance: _distance, ...connection }) => connection);

    connections.push(...adjacentCandidates);
    return connections;
  }, [projectDisplayPoints, projects, provinceNeighbors, provinceProjectHighlights, selectedPoint, selectedProject]);

  const nearbyProjects = useMemo(() => {
    if (!selectedPoint || !selectedProject) return [];
    return projects
      .map((project) => {
        const point = projectDisplayPoints.get(project.id);
        if (!point) return null;
        return { project, point, distance: distance(point, selectedPoint) };
      })
      .filter((item): item is { project: ProjectRecord; point: ScreenPoint; distance: number } => Boolean(item))
      .sort((a, b) => {
        const aSelected = a.project.id === selectedProject.id ? 1 : 0;
        const bSelected = b.project.id === selectedProject.id ? 1 : 0;
        return bSelected - aSelected || a.distance - b.distance;
      })
      .slice(0, 18);
  }, [projectDisplayPoints, projects, selectedPoint, selectedProject]);

  const visibleProjectsInView = useMemo(() => {
    if (!selectedProvince && !selectedProject) return [];
    return projects
      .map((project) => {
        const point = projectDisplayPoints.get(project.id);
        if (!point) return null;
        return { project, point };
      })
      .filter((item): item is { project: ProjectRecord; point: ScreenPoint } => {
        if (!item) return false;
        const inView =
          item.point.x >= viewBox.x &&
          item.point.x <= viewBox.x + viewBox.width &&
          item.point.y >= viewBox.y &&
          item.point.y <= viewBox.y + viewBox.height;
        return inView;
      })
      .sort((a, b) => a.project.id - b.project.id);
  }, [projectDisplayPoints, projects, selectedProject, selectedProvince, viewBox]);

  const focusProvince = useCallback(
    (provinceName: string) => {
      setSelectedProvince(provinceName);
      const provinceProjects = projects
        .filter((project) => normalizeProvinceName(project.province) === provinceName)
        .map((project) => {
          return projectDisplayPoints.get(project.id) ?? null;
        })
        .filter((point): point is ScreenPoint => Boolean(point));
      if (!provinceProjects.length) return;
      const minX = Math.min(...provinceProjects.map((point) => point.x));
      const maxX = Math.max(...provinceProjects.map((point) => point.x));
      const minY = Math.min(...provinceProjects.map((point) => point.y));
      const maxY = Math.max(...provinceProjects.map((point) => point.y));
      const width = Math.max(160, maxX - minX + 130);
      const height = Math.max(130, maxY - minY + 110);
      animateTo({ x: minX - 65, y: minY - 55, width, height }, 760);
    },
    [animateTo, projectDisplayPoints, projects],
  );

  const overlayLabels = useMemo<MapLabel[]>(() => {
    const candidates: MapLabel[] = [];
    for (const province of mapData.provinces) {
      if (showProvinceCounts) continue;
      if (!provinceNames.has(province.name)) continue;
      if (labelScale < 1.85 || province.name === activeProvince) {
        candidates.push({
          id: `province-${province.code}`,
          kind: "province",
          text: province.name,
          x: province.label.x,
          y: province.label.y,
          priority: province.name === activeProvince ? 1000 : 600 + (provinceNames.get(province.name) ?? 0),
          provinceName: province.name,
          active: province.name === activeProvince,
        });
      }
    }

    if (labelScale >= 1.75) {
      const cityLimit = labelScale < 2.5 ? 34 : labelScale < 4 ? 80 : 140;
      const sortedCities = cityPoints
        .filter((point) => point.type === "city")
        .sort((a, b) => {
          const aActive = selectedProject && a.projectIds.includes(selectedProject.id) ? 1 : 0;
          const bActive = selectedProject && b.projectIds.includes(selectedProject.id) ? 1 : 0;
          return bActive - aActive || b.count - a.count;
        });
      const visibleCities = sortedCities.slice(0, cityLimit);
      const activeCity = selectedProject ? sortedCities.find((point) => point.projectIds.includes(selectedProject.id)) : undefined;
      const cityCandidates = activeCity && !visibleCities.some((point) => point.id === activeCity.id) ? [activeCity, ...visibleCities] : visibleCities;
      for (const point of cityCandidates) {
        const isActiveCity = selectedProject ? point.projectIds.includes(selectedProject.id) : false;
        candidates.push({
          id: `city-${point.id}`,
          kind: "city",
          text: point.label,
          x: point.lng,
          y: point.lat,
          offsetY: isActiveCity ? -54 : -18,
          priority: isActiveCity ? 1600 : 360 + point.count,
          active: isActiveCity,
        });
      }
    }

    if ((selectedProvince || selectedProject) && labelScale >= 1.35) {
      const companyItems = selectedProvince ? visibleProjectsInView : nearbyProjects;
      for (const item of companyItems) {
        const isActive = selectedProject ? item.project.id === selectedProject.id : false;
        if (isActive) continue;
        const priorityDistance = "distance" in item && typeof item.distance === "number" ? item.distance : item.project.id;
        const offset = stableLabelOffset(item.project.id, isActive);
        candidates.push({
          id: `company-${item.project.id}`,
          kind: "company",
          text: `${companyCode(item.project)} ${item.project.company}`,
          x: item.point.x,
          y: item.point.y,
          offsetX: offset.x,
          offsetY: offset.y,
          priority: isActive ? 2000 : 900 - priorityDistance,
          active: isActive,
          projectId: item.project.id,
        });
      }
    }

    const reservedBoxes: Array<{ x: number; y: number; width: number; height: number }> = [];
    if (showMapHelp) {
      reservedBoxes.push({
        x: 10,
        y: Math.max(0, viewportSize.height - 130),
        width: Math.min(240, viewportSize.width - 20),
        height: 120,
      });
    }
    if (selectedProject && selectedPoint) {
      const anchor = mapToScreen(selectedPoint.x, selectedPoint.y);
      const popoverWidth = Math.min(300, viewportSize.width - 32);
      const popoverX = Math.max(popoverWidth / 2 + 8, Math.min(viewportSize.width - popoverWidth / 2 - 8, anchor.x + (anchor.x > viewportSize.width * 0.62 ? -170 : 170)));
      const popoverY = Math.max(88, Math.min(viewportSize.height - 116, anchor.y - 70));
      reservedBoxes.push({ x: popoverX - popoverWidth / 2, y: popoverY - 58, width: popoverWidth, height: 116 });
    }
    const placed: Array<{ x: number; y: number; width: number; height: number }> = [...reservedBoxes];
    return candidates
      .map((label) => {
        const base = mapToScreen(label.x, label.y);
        return { label, screen: { x: base.x + (label.offsetX ?? 0), y: base.y + (label.offsetY ?? 0) } };
      })
      .filter(({ screen }) => screen.x > -90 && screen.y > -40 && screen.x < viewportSize.width + 90 && screen.y < viewportSize.height + 40)
      .sort((a, b) => b.label.priority - a.label.priority)
      .filter(({ label, screen }) => {
        const width = label.kind === "company" ? Math.min(240, Math.max(88, label.text.length * 12)) : label.kind === "province" ? 52 : 46;
        const height = label.kind === "company" ? 32 : 24;
        const box = { x: screen.x - width / 2, y: screen.y - height / 2, width, height };
        if (reservedBoxes.some((item) => boxesOverlap(box, item))) return false;
        const forceKeep = label.active && (label.kind === "company" || label.kind === "city");
        if (placed.some((item) => boxesOverlap(box, item)) && !forceKeep) return false;
        placed.push(box);
        return true;
      })
      .map(({ label }) => label);
  }, [
    activeProvince,
    cityPoints,
    labelScale,
    mapData.provinces,
    mapToScreen,
    nearbyProjects,
    provinceNames,
    selectedProject,
    selectedProvince,
    selectedPoint,
    showMapHelp,
    showProvinceCounts,
    viewportSize,
    visibleProjectsInView,
  ]);

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
        const startViewport = renderedViewport(gesture.startViewBox, viewportSize);
        const centerRatioX = (center.x - startViewport.x) / startViewport.width;
        const centerRatioY = (center.y - startViewport.y) / startViewport.height;
        const nextWidth = gesture.startViewBox.width * factor;
        const nextHeight = gesture.startViewBox.height * factor;
        setClampedViewBox({
          x: anchor.x - centerRatioX * nextWidth,
          y: anchor.y - centerRatioY * nextHeight,
          width: nextWidth,
          height: nextHeight,
        });
        gesture.moved = true;
      } else if (gesture.mode === "pan") {
        const dx = event.clientX - gesture.startX;
        const dy = event.clientY - gesture.startY;
        if (Math.hypot(dx, dy) > 3) gesture.moved = true;
        const startViewport = renderedViewport(gesture.startViewBox, viewportSize);
        setClampedViewBox({
          ...gesture.startViewBox,
          x: gesture.startViewBox.x - (dx / startViewport.width) * gesture.startViewBox.width,
          y: gesture.startViewBox.y - (dy / startViewport.height) * gesture.startViewBox.height,
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
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <defs>
          <linearGradient id="provinceHighlight" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#f97316" />
            <stop offset="50%" stopColor="#facc15" />
            <stop offset="100%" stopColor="#22d3ee" />
          </linearGradient>
          <radialGradient id="provinceProjectGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#67e8f9" stopOpacity="0.98" />
            <stop offset="44%" stopColor="#22d3ee" stopOpacity="0.72" />
            <stop offset="100%" stopColor="#0e7490" stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect className="map-water" x="0" y="0" width={fullViewBox.width} height={fullViewBox.height} />
        <g className="province-fills">
          {mapData.provinces.map((province) => (
            <path
              key={province.code}
              className={`province-area ${province.name === activeProvince ? "is-active" : ""}`}
              d={province.path}
              fill={provinceFill[province.colorIndex % provinceFill.length]}
              onClick={() => {
                if (!gestureRef.current.moved) focusProvince(province.name);
              }}
            />
          ))}
        </g>
        {activeProvince && (
          <g className="province-glow" aria-hidden="true">
            {mapData.provinces
              .filter((province) => province.name === activeProvince)
              .map((province) => (
                <g key={`${province.code}-glow`}>
                  <path className="province-glow-ring ring-one" d={province.path} />
                  <path className="province-glow-ring ring-two" d={province.path} />
                  <path className="province-glow-core" d={province.path} />
                </g>
              ))}
          </g>
        )}
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
        <g className="province-boundaries">
          {mapData.provinces.map((province) => (
            <path key={`${province.code}-line`} className={province.name === activeProvince ? "is-active" : ""} d={province.path} />
          ))}
        </g>
        <g className="province-hit-areas">
          {mapData.provinces.map((province) => (
            <path
              key={`${province.code}-hit`}
              d={province.path}
              onClick={() => {
                if (!gestureRef.current.moved) focusProvince(province.name);
              }}
            />
          ))}
        </g>
        {provinceProjectConnections.length > 0 && (
          <g className="province-project-links" aria-hidden="true">
            {provinceProjectConnections.map((connection) => (
              <line
                key={connection.id}
                className={connection.kind === "adjacent-province" ? "is-adjacent" : "is-same-province"}
                x1={connection.x1}
                y1={connection.y1}
                x2={connection.x2}
                y2={connection.y2}
              />
            ))}
          </g>
        )}
        {provinceProjectHighlights.length > 0 && (
          <g className="province-project-highlights">
            {provinceProjectHighlights.map((point) => {
              const ringRadius = 8 / pxPerMapUnit;
              const coreRadius = (point.selected ? 3.8 : 2.8) / pxPerMapUnit;
              return (
                <g
                  key={`province-project-${point.id}`}
                  className={`province-project-point ${point.selected ? "is-selected" : ""}`}
                  role="button"
                  tabIndex={0}
                  aria-label={`定位项目 ${companyCode(projects.find((project) => project.id === point.id) ?? selectedProject ?? projects[0])}`}
                  onClick={() => {
                    if (!gestureRef.current.moved) onSelectProject(point.id);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") onSelectProject(point.id);
                  }}
                >
                  <circle className="province-project-ring" cx={point.x} cy={point.y} r={ringRadius} />
                  <circle className="province-project-core" cx={point.x} cy={point.y} r={coreRadius} />
                </g>
              );
            })}
          </g>
        )}
        <g className="project-points">
          {cityPoints.map((point) => {
            const belongsToSelectedProject = selectedProject ? point.projectIds.includes(selectedProject.id) : false;
            if (belongsToSelectedProject) return null;
            const active = false;
            const radiusPx = active ? 7 : Math.min(6, 2.8 + point.count * 0.3);
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

      {visibleProvinceCountLabels.length > 0 && (
        <div className="province-count-layer" aria-hidden="true">
          {visibleProvinceCountLabels.map((province) => {
            return (
              <button
                key={`province-count-${province.code}`}
                className={`province-count-marker ${province.name === activeProvince ? "is-active" : ""}`}
                type="button"
                style={{ transform: `translate(${province.screen.x}px, ${province.screen.y}px) translate(-50%, -50%)` }}
                onClick={() => focusProvince(province.name)}
                tabIndex={-1}
              >
                <span>{province.name}</span>
                <strong>{province.count}</strong>
              </button>
            );
          })}
        </div>
      )}

      <div className="map-label-layer" aria-hidden="true">
        {overlayLabels.map((label) => {
          const base = mapToScreen(label.x, label.y);
          const screen = { x: base.x + (label.offsetX ?? 0), y: base.y + (label.offsetY ?? 0) };
          const lineLength = Math.hypot(screen.x - base.x, screen.y - base.y);
          const lineAngle = Math.atan2(screen.y - base.y, screen.x - base.x) * (180 / Math.PI);
          return (
            <div key={label.id}>
              {label.kind !== "province" && (
                <>
                  <span className={`label-anchor is-${label.kind}`} style={{ transform: `translate(${base.x}px, ${base.y}px) translate(-50%, -50%)` }} />
                  <span className={`label-leader is-${label.kind}`} style={{ width: `${lineLength}px`, transform: `translate(${base.x}px, ${base.y}px) rotate(${lineAngle}deg)` }} />
                </>
              )}
              <button
                className={`map-label is-${label.kind} ${label.active ? "is-active" : ""}`}
                type="button"
                style={{ transform: `translate(${screen.x}px, ${screen.y}px) translate(-50%, -50%)` }}
                onClick={() => {
                  if (label.projectId) onSelectProject(label.projectId);
                  if (label.provinceName) focusProvince(label.provinceName);
                }}
                tabIndex={-1}
              >
                {label.text}
              </button>
            </div>
          );
        })}
      </div>

      {selectedProject && selectedPoint && (() => {
        const anchor = mapToScreen(selectedPoint.x, selectedPoint.y);
        const popoverX = Math.max(150, Math.min(viewportSize.width - 160, anchor.x + (anchor.x > viewportSize.width * 0.62 ? -170 : 170)));
        const popoverY = Math.max(88, Math.min(viewportSize.height - 116, anchor.y - 70));
        const lineLength = Math.hypot(popoverX - anchor.x, popoverY - anchor.y);
        const lineAngle = Math.atan2(popoverY - anchor.y, popoverX - anchor.x) * (180 / Math.PI);
        return (
          <div className="selected-location-layer">
            <span className="selected-anchor" style={{ transform: `translate(${anchor.x}px, ${anchor.y}px) translate(-50%, -50%)` }} />
            <span className="selected-leader" style={{ width: `${lineLength}px`, transform: `translate(${anchor.x}px, ${anchor.y}px) rotate(${lineAngle}deg)` }} />
            <article className="map-popover" style={{ transform: `translate(${popoverX}px, ${popoverY}px) translate(-50%, -50%)` }}>
              <button type="button" className="popover-close" aria-label="关闭项目详情" onClick={onClearSelection}><X size={15} /></button>
              <span>{companyCode(selectedProject)} · {selectedProject.displayCityLabel || selectedProject.displayCity}</span>
              <strong>{selectedProject.company}</strong>
              <p>{selectedProject.address}</p>
            </article>
          </div>
        );
      })()}

      <div className="map-help">
        <button type="button" className="map-help-toggle" onClick={() => setShowMapHelp((current) => !current)} aria-expanded={showMapHelp}>
          <CircleHelp size={16} /> 地图使用说明 {showMapHelp ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
        {showMapHelp && (
          <div className="map-help-body">
            <span><MousePointer2 size={14} />拖拽移动 · 滚轮缩放</span>
            <span><i className="legend-dot" />圆点为项目，数字为聚合数量</span>
            <span><i className="legend-label" />省 → 市 → 企业，随缩放分级显示</span>
          </div>
        )}
      </div>

      <div className="map-scale-indicator">{currentScale < 1.2 ? "全国" : currentScale < 2.4 ? "区域" : currentScale < 4.5 ? "城市" : "项目"} · {Math.round(currentScale * 100)}%</div>
      <div className="map-controls" aria-label="地图缩放">
        <button type="button" onClick={() => zoom(0.66)} aria-label="放大地图">
          <Plus size={18} />
        </button>
        <button type="button" onClick={() => zoom(1.45)} aria-label="缩小地图">
          <Minus size={18} />
        </button>
        <button
          type="button"
          onClick={() => {
            setSelectedProvince(null);
            animateTo(fullViewBox, 420);
          }}
          aria-label="显示全国"
        >
          <RotateCcw size={16} /> 全国
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
  const [isMobileLayout, setIsMobileLayout] = useState(() => window.innerWidth <= 780);
  const [mobileDrawerExpanded, setMobileDrawerExpanded] = useState(false);

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

  useEffect(() => {
    const media = window.matchMedia("(max-width: 780px)");
    const sync = (matches: boolean) => {
      setIsMobileLayout(matches);
      if (!matches) setMobileDrawerExpanded(false);
    };
    sync(media.matches);
    const handleChange = (event: MediaQueryListEvent) => sync(event.matches);
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
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

  const onSelectProject = useCallback((projectId: number) => {
    setSelectedProjectId(projectId);
    if (window.innerWidth <= 780) setMobileDrawerExpanded(false);
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

      <section className={`workspace ${isMobileLayout ? "is-mobile" : ""} ${mobileDrawerExpanded ? "drawer-expanded" : "drawer-collapsed"}`}>
        <section className="visual-pane is-active">
          <div className="toolbar">
            <div className="search-box">
              <Search size={18} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && filteredProjects.length) onSelectProject(filteredProjects[0].id);
                  if (event.key === "Escape") clearSearch();
                }}
                placeholder="搜索编号、公司、城市、地址"
                aria-label="搜索编号、公司、城市、地址"
              />
              {query && <span className="search-count">{filteredProjects.length} 条</span>}
              {query && (
                <button className="ghost-button" type="button" onClick={clearSearch}>
                  清除
                </button>
              )}
            </div>

            <div className="map-mode-note">
              <MapPin size={16} />
              高精度矢量地图
            </div>

            <div className="segmented" aria-label="坐标模式">
              <button className={coordinateMode === "city" ? "is-active" : ""} type="button" onClick={() => setCoordinateMode("city")}>
                <Layers3 size={16} />
                地级市
              </button>
              <button className={coordinateMode === "address" ? "is-active" : ""} type="button" onClick={() => setCoordinateMode("address")}>
                <LocateFixed size={16} />
                区县级
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
              onClearSelection={() => setSelectedProjectId(null)}
            />
          </div>
        </section>

        <aside className="side-panel is-active">
          <div className="panel-head">
            <div>
              <span className="eyebrow">
                <ListFilter size={14} />
                项目清单
              </span>
              <h2>{visibleProjects.length} 条记录</h2>
            </div>
            <div className="panel-head-actions">
              {isMobileLayout && (
                <button
                  className={`drawer-toggle ${mobileDrawerExpanded ? "is-expanded" : ""}`}
                  type="button"
                  onClick={() => setMobileDrawerExpanded((current) => !current)}
                  aria-label={mobileDrawerExpanded ? "收起公司抽屉" : "展开公司抽屉"}
                >
                  <ChevronUp size={15} />
                  {mobileDrawerExpanded ? "收起" : "展开"}
                </button>
              )}
              <div className="db-badge">
                <Database size={14} />
                本地数据
              </div>
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
