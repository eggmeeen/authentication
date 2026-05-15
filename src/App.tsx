import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import * as THREE from "three";
import {
  Building2,
  Database,
  FileText,
  Globe2,
  Layers3,
  ListFilter,
  Loader2,
  LocateFixed,
  Map as MapIcon,
  MapPin,
  Moon,
  Search,
  Sun,
} from "lucide-react";
import type { BoundaryDataset, CoordinateMode, MapPoint, ProjectDataset, ProjectRecord, ThemeMode, ViewMode } from "./types";

const CHINA_CENTER: [number, number] = [35.8617, 104.1954];
const DAY_TILE_URL = "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png";
const NIGHT_TILE_URL = "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    };
    return entities[char];
  });
}

function coordFor(project: ProjectRecord, mode: CoordinateMode) {
  if (mode === "address" && project.addressCoord) {
    return project.addressCoord;
  }
  return project.cityCoord ?? project.addressCoord;
}

function buildCityPoints(projects: ProjectRecord[]): MapPoint[] {
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
    groups.set(key, {
      id: key,
      type: "city",
      label: project.displayCityLabel || project.displayCity,
      sublabel: `${project.province} · ${project.displayCity}`,
      count: 1,
      lng: project.cityCoord.lng,
      lat: project.cityCoord.lat,
      projectId: project.id,
      projectIds: [project.id],
    });
  }
  return Array.from(groups.values()).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "zh-CN"));
}

function buildProjectPoints(projects: ProjectRecord[], mode: CoordinateMode): MapPoint[] {
  const seen = new Map<string, number>();
  const points: MapPoint[] = [];
  for (const project of projects) {
    const coord = coordFor(project, mode);
    if (!coord) continue;
    const coordKey = `${coord.lng.toFixed(4)}|${coord.lat.toFixed(4)}`;
    const index = seen.get(coordKey) ?? 0;
    seen.set(coordKey, index + 1);
    const angle = ((project.id * 137.508 + index * 31) % 360) * (Math.PI / 180);
    const radius = mode === "address" ? Math.min(0.06, index * 0.012) : 0;
    points.push({
      id: `project-${project.id}`,
      type: "project",
      label: project.company,
      sublabel: `${project.displayCityLabel || project.displayCity} · ${project.district || "地级行政区"}`,
      count: 1,
      lng: coord.lng + Math.cos(angle) * radius,
      lat: coord.lat + Math.sin(angle) * radius,
      projectId: project.id,
      projectIds: [project.id],
    });
  }
  return points;
}

function boxesOverlap(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function shouldLabelPoint(
  point: MapPoint,
  map: L.Map,
  placedBoxes: Array<{ x: number; y: number; width: number; height: number }>,
  selectedId: number | null,
  totalPoints: number,
): boolean {
  const zoom = map.getZoom();
  const selected = selectedId !== null && point.projectIds.includes(selectedId);
  if (!selected && totalPoints > 120 && zoom < 4.8 && point.count < 3) return false;
  if (!selected && totalPoints > 80 && zoom < 5.4 && point.count < 2) return false;

  const screen = map.latLngToContainerPoint([point.lat, point.lng]);
  const width = Math.min(132, Math.max(82, point.label.length * 14 + 36));
  const height = 38;
  const box = { x: screen.x - width / 2, y: screen.y - height / 2, width, height };
  if (!selected && placedBoxes.some((placed) => boxesOverlap(box, placed))) return false;
  placedBoxes.push(box);
  return true;
}

function latLngToVector(lat: number, lng: number, radius = 1): THREE.Vector3 {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lng + 180) * (Math.PI / 180);
  return new THREE.Vector3(
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta),
  );
}

function easeInOutCubic(value: number): number {
  return value < 0.5 ? 4 * value * value * value : 1 - Math.pow(-2 * value + 2, 3) / 2;
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

function MapCanvas({
  projects,
  selectedProject,
  coordinateMode,
  theme,
  onSelectProject,
}: {
  projects: ProjectRecord[];
  selectedProject: ProjectRecord | null;
  coordinateMode: CoordinateMode;
  theme: ThemeMode;
  onSelectProject: (projectId: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  const [mapZoom, setMapZoom] = useState(4);
  const selectedId = selectedProject?.id ?? null;

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, {
      center: CHINA_CENTER,
      zoom: 4,
      minZoom: 3,
      maxZoom: 12,
      zoomControl: false,
      preferCanvas: true,
    });
    L.control.zoom({ position: "bottomright" }).addTo(map);
    const tileLayer = L.tileLayer(theme === "night" ? NIGHT_TILE_URL : DAY_TILE_URL, {
      attribution: TILE_ATTRIBUTION,
      maxZoom: 19,
    }).addTo(map);
    tileLayerRef.current = tileLayer;
    const layer = L.layerGroup().addTo(map);
    map.on("zoomend moveend", () => setMapZoom(map.getZoom()));
    mapRef.current = map;
    layerRef.current = layer;
    setTimeout(() => map.invalidateSize(), 50);
  }, [theme]);

  useEffect(() => {
    tileLayerRef.current?.setUrl(theme === "night" ? NIGHT_TILE_URL : DAY_TILE_URL);
  }, [theme]);

  useEffect(() => {
    const layer = layerRef.current;
    const map = mapRef.current;
    if (!layer || !map) return;
    layer.clearLayers();

    const points = coordinateMode === "city" ? buildCityPoints(projects) : buildProjectPoints(projects, coordinateMode);
    const placedBoxes: Array<{ x: number; y: number; width: number; height: number }> = [];
    const bounds: [number, number][] = [];

    const orderedPoints = [...points].sort((a, b) => {
      const aActive = a.projectIds.includes(selectedId ?? -1) ? 1 : 0;
      const bActive = b.projectIds.includes(selectedId ?? -1) ? 1 : 0;
      return bActive - aActive || b.count - a.count || a.label.localeCompare(b.label, "zh-CN");
    });

    for (const point of orderedPoints) {
      const isActive =
        point.projectIds.includes(selectedId ?? -1) ||
        (selectedProject ? point.id === `${selectedProject.province}|${selectedProject.displayCity}` : false);
      bounds.push([point.lat, point.lng]);
      if (coordinateMode === "city") {
        const showLabel = shouldLabelPoint(point, map, placedBoxes, selectedId, points.length);
        if (showLabel) {
          const marker = L.marker([point.lat, point.lng], {
            icon: L.divIcon({
              className: "city-div-icon",
              html: `<span class="city-pill ${isActive ? "is-active" : ""}"><span>${escapeHtml(
                point.label,
              )}</span><strong>${point.count}</strong></span>`,
              iconSize: [104, 38],
              iconAnchor: [52, 19],
            }),
          });
          marker.on("click", () => onSelectProject(point.projectId));
          marker.addTo(layer);
        } else {
          const marker = L.circleMarker([point.lat, point.lng], {
            radius: Math.min(8, 3 + point.count * 0.45),
            color: isActive ? "#ef4444" : theme === "night" ? "#67e8f9" : "#155e75",
            weight: isActive ? 3 : 1,
            fillColor: isActive ? "#f97316" : theme === "night" ? "#22d3ee" : "#10b981",
            fillOpacity: isActive ? 0.95 : 0.62,
          });
          marker.on("click", () => onSelectProject(point.projectId));
          marker.addTo(layer);
        }
      } else {
        const marker = L.circleMarker([point.lat, point.lng], {
          radius: isActive ? 9 : 5,
          color: isActive ? "#ef4444" : "#155e75",
          weight: isActive ? 3 : 1.5,
          fillColor: isActive ? "#f97316" : "#10b981",
          fillOpacity: isActive ? 0.92 : 0.72,
        });
        const project = projects.find((item) => item.id === point.projectId);
        if (project) {
          marker.bindPopup(
            `<div class="map-popup"><strong>${escapeHtml(project.company)}</strong><span>${escapeHtml(
              project.displayCity,
            )}${project.district ? ` · ${escapeHtml(project.district)}` : ""}</span><p>${escapeHtml(
              project.address,
            )}</p></div>`,
            { maxWidth: 300 },
          );
        }
        marker.on("click", () => onSelectProject(point.projectId));
        marker.addTo(layer);
      }
    }

    if (bounds.length && !selectedProject) {
      map.fitBounds(bounds, { padding: [50, 50], maxZoom: 5 });
    }
  }, [coordinateMode, mapZoom, onSelectProject, projects, selectedId, selectedProject, theme]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selectedProject) return;
    const coord = coordFor(selectedProject, coordinateMode);
    if (!coord) return;
    map.flyTo([coord.lat, coord.lng], coordinateMode === "city" ? 7 : 9, {
      animate: true,
      duration: 1.35,
      easeLinearity: 0.25,
    });
  }, [coordinateMode, selectedProject]);

  return <div className="map-canvas" ref={containerRef} />;
}

function GlobeCanvas({
  projects,
  selectedProject,
  coordinateMode,
  theme,
  onSelectProject,
}: {
  projects: ProjectRecord[];
  selectedProject: ProjectRecord | null;
  coordinateMode: CoordinateMode;
  theme: ThemeMode;
  onSelectProject: (projectId: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    globe: THREE.Group;
    pointGroup: THREE.Group;
    labelGroup: HTMLButtonElement[];
    raycaster: THREE.Raycaster;
    pointer: THREE.Vector2;
    frame: number;
    animationStart: number;
    animationFrom: THREE.Vector3;
    animationTo: THREE.Vector3;
    animationActive: boolean;
    autoRotate: boolean;
    selectedMesh: THREE.Mesh | null;
  } | null>(null);
  const selectedIdRef = useRef<number | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || sceneRef.current) return;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    camera.position.copy(latLngToVector(35.8617, 104.1954, 3.05));
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.6));
    container.appendChild(renderer.domElement);

    const globe = new THREE.Group();
    scene.add(globe);

    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(1, 48, 24),
      new THREE.MeshBasicMaterial({
        color: theme === "night" ? 0x07111d : 0xf5fbff,
        transparent: true,
        opacity: theme === "night" ? 0.18 : 0.16,
        depthWrite: false,
      }),
    );
    globe.add(sphere);

    const wire = new THREE.LineSegments(
      new THREE.WireframeGeometry(new THREE.SphereGeometry(1.002, 24, 12)),
      new THREE.LineDashedMaterial({
        color: theme === "night" ? 0x60a5fa : 0x155e75,
        transparent: true,
        opacity: theme === "night" ? 0.42 : 0.34,
        dashSize: 0.025,
        gapSize: 0.018,
      }),
    );
    wire.computeLineDistances();
    globe.add(wire);

    const pointGroup = new THREE.Group();
    globe.add(pointGroup);

    const ambient = new THREE.AmbientLight(0xffffff, theme === "night" ? 0.7 : 0.95);
    scene.add(ambient);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const state = {
      renderer,
      scene,
      camera,
      globe,
      pointGroup,
      labelGroup: [] as HTMLButtonElement[],
      raycaster,
      pointer,
      frame: 0,
      animationStart: 0,
      animationFrom: camera.position.clone(),
      animationTo: camera.position.clone(),
      animationActive: false,
      autoRotate: true,
      selectedMesh: null as THREE.Mesh | null,
    };
    sceneRef.current = state;

    const resize = () => {
      const rect = container.getBoundingClientRect();
      const width = Math.max(1, Math.floor(rect.width));
      const height = Math.max(1, Math.floor(rect.height));
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };

    const renderFrame = (now: number) => {
      if (!sceneRef.current) return;
      const current = sceneRef.current;
      if (current.animationActive) {
        const elapsed = Math.min(1, (now - current.animationStart) / 1550);
        const eased = easeInOutCubic(elapsed);
        const outward = current.animationFrom.clone().normalize().multiplyScalar(3.9);
        const targetOut = current.animationTo.clone().normalize().multiplyScalar(3.9);
        const close = current.animationTo.clone();
        let position: THREE.Vector3;
        if (elapsed < 0.38) {
          position = current.animationFrom.clone().lerp(outward, easeInOutCubic(elapsed / 0.38));
        } else if (elapsed < 0.78) {
          position = outward.lerp(targetOut, easeInOutCubic((elapsed - 0.38) / 0.4));
        } else {
          position = targetOut.lerp(close, easeInOutCubic((elapsed - 0.78) / 0.22));
        }
        current.camera.position.copy(position);
        current.camera.lookAt(0, 0, 0);
        if (current.selectedMesh) {
          const scale = 1 + Math.sin(eased * Math.PI) * 0.7;
          current.selectedMesh.scale.setScalar(scale);
        }
        if (elapsed >= 1) {
          current.animationActive = false;
          current.autoRotate = selectedIdRef.current === null;
          current.selectedMesh?.scale.setScalar(1.35);
        }
      } else if (current.autoRotate) {
        current.globe.rotation.y += 0.0009;
      }

      current.renderer.render(current.scene, current.camera);
      const overlay = overlayRef.current;
      if (overlay) {
        const rect = current.renderer.domElement.getBoundingClientRect();
        for (const label of current.labelGroup) {
          const mesh = (label as HTMLButtonElement & { __mesh?: THREE.Object3D }).__mesh;
          if (!mesh) continue;
          const world = new THREE.Vector3();
          mesh.getWorldPosition(world);
          const normal = world.clone().normalize();
          const cameraDir = current.camera.position.clone().normalize();
          const visible = normal.dot(cameraDir) > -0.18;
          const projected = world.project(current.camera);
          label.style.display = visible ? "inline-flex" : "none";
          label.style.transform = `translate(${((projected.x + 1) / 2) * rect.width}px, ${((-projected.y + 1) / 2) * rect.height}px) translate(-50%, -50%)`;
        }
      }
      current.frame = window.requestAnimationFrame(renderFrame);
    };

    state.frame = window.requestAnimationFrame(renderFrame);
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();

    const onPointerDown = (event: PointerEvent) => {
      const current = sceneRef.current;
      if (!current) return;
      const rect = current.renderer.domElement.getBoundingClientRect();
      current.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      current.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      current.raycaster.setFromCamera(current.pointer, current.camera);
      const hits = current.raycaster.intersectObjects(current.pointGroup.children, false);
      const hit = hits[0]?.object as THREE.Mesh & { userData: MapPoint };
      if (hit?.userData?.projectId) onSelectProject(hit.userData.projectId);
    };
    renderer.domElement.addEventListener("pointerdown", onPointerDown);

    return () => {
      observer.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      window.cancelAnimationFrame(state.frame);
      renderer.dispose();
      container.removeChild(renderer.domElement);
      sceneRef.current = null;
    };
  }, [onSelectProject, theme]);

  useEffect(() => {
    const current = sceneRef.current;
    if (!current) return;
    const points = coordinateMode === "city" ? buildCityPoints(projects) : buildProjectPoints(projects, coordinateMode);
    const selectedId = selectedProject?.id ?? -1;
    current.pointGroup.clear();
    overlayRef.current?.replaceChildren();
    current.labelGroup = [];

    const material = new THREE.MeshBasicMaterial({ color: theme === "night" ? 0x2dd4bf : 0x0f766e });
    const selectedMaterial = new THREE.MeshBasicMaterial({ color: 0xfb7185 });
    for (const point of points) {
      const radius = point.projectIds.includes(selectedId) ? 0.018 : Math.min(0.016, 0.007 + point.count * 0.0014);
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 10, 6), point.projectIds.includes(selectedId) ? selectedMaterial : material);
      mesh.position.copy(latLngToVector(point.lat, point.lng, 1.025));
      mesh.userData = point;
      current.pointGroup.add(mesh);

      const shouldShowLabel =
        point.projectIds.includes(selectedId) ||
        (coordinateMode === "city" && points.length <= 90 && point.count >= 2) ||
        (coordinateMode === "address" && points.length <= 16);
      if (shouldShowLabel && overlayRef.current) {
        const label = document.createElement("button") as HTMLButtonElement & { __mesh?: THREE.Object3D };
        label.type = "button";
        label.className = point.projectIds.includes(selectedId) ? "globe-label is-active" : "globe-label";
        label.textContent = point.type === "city" ? `${point.label} ${point.count}` : point.label;
        label.__mesh = mesh;
        label.addEventListener("click", (event) => {
          event.stopPropagation();
          onSelectProject(point.projectId);
        });
        overlayRef.current.appendChild(label);
        current.labelGroup.push(label);
      }
    }
  }, [coordinateMode, onSelectProject, projects, selectedProject?.id, theme]);

  useEffect(() => {
    const current = sceneRef.current;
    if (!current) return;
    fetch(`${import.meta.env.BASE_URL}data/china-boundaries.json`)
      .then((response) => response.json() as Promise<BoundaryDataset>)
      .then((data) => {
        if (!sceneRef.current || sceneRef.current !== current) return;
        const makeLines = (lines: number[][][], color: number, opacity: number, radius: number) => {
          const vertices: number[] = [];
          for (const line of lines) {
            for (let index = 1; index < line.length; index += 1) {
              const a = latLngToVector(line[index - 1][1], line[index - 1][0], radius);
              const b = latLngToVector(line[index][1], line[index][0], radius);
              vertices.push(a.x, a.y, a.z, b.x, b.y, b.z);
            }
          }
          const geometry = new THREE.BufferGeometry();
          geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
          return new THREE.LineSegments(
            geometry,
            new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }),
          );
        };
        current.globe.add(makeLines(data.cityLines, theme === "night" ? 0x22d3ee : 0x2563eb, theme === "night" ? 0.38 : 0.34, 1.012));
        current.globe.add(makeLines(data.provinceLines, theme === "night" ? 0xfacc15 : 0xf97316, theme === "night" ? 0.86 : 0.72, 1.018));
      })
      .catch(() => undefined);
  }, [theme]);

  useEffect(() => {
    const current = sceneRef.current;
    if (!current) return;
    if (!selectedProject) {
      selectedIdRef.current = null;
      current.autoRotate = true;
      current.selectedMesh?.scale.setScalar(1);
      current.selectedMesh = null;
      return;
    }
    const coord = coordFor(selectedProject, coordinateMode);
    if (!coord) return;
    selectedIdRef.current = selectedProject.id;
    current.selectedMesh = null;
    for (const child of current.pointGroup.children) {
      const mesh = child as THREE.Mesh & { userData: MapPoint };
      if (mesh.userData.projectIds?.includes(selectedProject.id)) {
        current.selectedMesh = mesh;
        mesh.scale.setScalar(1.35);
      } else {
        mesh.scale.setScalar(1);
      }
    }
    const worldTarget = new THREE.Vector3();
    if (current.selectedMesh) {
      current.selectedMesh.getWorldPosition(worldTarget);
    } else {
      worldTarget.copy(latLngToVector(coord.lat, coord.lng, 1));
    }
    current.animationFrom = current.camera.position.clone();
    current.animationTo = worldTarget.normalize().multiplyScalar(coordinateMode === "city" ? 2.28 : 2.02);
    current.animationStart = performance.now();
    current.animationActive = true;
    current.autoRotate = false;
  }, [coordinateMode, selectedProject]);

  return (
    <div className="globe-canvas" ref={containerRef}>
      <div className="globe-overlay" ref={overlayRef} />
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
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("map");
  const [coordinateMode, setCoordinateMode] = useState<CoordinateMode>("city");
  const [theme, setTheme] = useState<ThemeMode>("day");
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}data/projects.json`)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<ProjectDataset>;
      })
      .then((data) => {
        setDataset(data);
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
    if (!dataset) return null;
    if (!selectedProjectId) return null;
    return dataset.projects.find((project) => project.id === selectedProjectId) ?? null;
  }, [dataset, filteredProjects, selectedProjectId]);

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

  if (!dataset) {
    return (
      <main className="loading-page">
        <Loader2 className="spin" size={32} />
        <strong>正在加载项目数据库</strong>
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

            <div className="segmented" aria-label="视图">
              <button className={viewMode === "map" ? "is-active" : ""} type="button" onClick={() => setViewMode("map")}>
                <MapIcon size={16} />
                地图
              </button>
              <button className={viewMode === "globe" ? "is-active" : ""} type="button" onClick={() => setViewMode("globe")}>
                <Globe2 size={16} />
                地球
              </button>
            </div>

            <div className="segmented" aria-label="坐标模式">
              <button
                className={coordinateMode === "city" ? "is-active" : ""}
                type="button"
                onClick={() => setCoordinateMode("city")}
              >
                <Layers3 size={16} />
                地级市
              </button>
              <button
                className={coordinateMode === "address" ? "is-active" : ""}
                type="button"
                onClick={() => setCoordinateMode("address")}
              >
                <LocateFixed size={16} />
                精确地址
              </button>
            </div>
          </div>

          <div className={`stage ${viewMode === "globe" ? "is-globe" : ""}`}>
            {viewMode === "map" ? (
              <MapCanvas
                projects={visibleProjects}
                selectedProject={selectedProject}
                coordinateMode={coordinateMode}
                theme={theme}
                onSelectProject={onSelectProject}
              />
            ) : (
              <GlobeCanvas
                projects={visibleProjects}
                selectedProject={selectedProject}
                coordinateMode={coordinateMode}
                theme={theme}
                onSelectProject={onSelectProject}
              />
            )}
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
              JSON / SQLite
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
