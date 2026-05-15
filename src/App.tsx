import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  const fullViewBox = useMemo<MapViewBox>(
    () => ({ x: 0, y: 0, width: mapData.metadata.width, height: mapData.metadata.height }),
    [mapData],
  );
  const [viewBox, setViewBox] = useState<MapViewBox>(fullViewBox);
  const viewBoxRef = useRef(viewBox);

  useEffect(() => {
    viewBoxRef.current = viewBox;
  }, [viewBox]);

  useEffect(() => {
    setViewBox(fullViewBox);
  }, [fullViewBox]);

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
  const isZoomedOut = scale < 1.22;
  const provinceFill = theme === "night" ? NIGHT_PROVINCE_COLORS : PROVINCE_COLORS;
  const activeProvince = selectedProject ? normalizeProvinceName(selectedProject.province) : null;

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
      const current = viewBoxRef.current;
      const centerX = current.x + current.width / 2;
      const centerY = current.y + current.height / 2;
      const nextWidth = current.width * factor;
      const nextHeight = current.height * factor;
      animateTo({ x: centerX - nextWidth / 2, y: centerY - nextHeight / 2, width: nextWidth, height: nextHeight }, 260);
    },
    [animateTo],
  );

  return (
    <div className="map-canvas">
      <svg
        className="china-map"
        viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
        role="img"
        aria-label="中国认证项目分布线框图"
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
        <g className="province-boundaries">
          {mapData.provinces.map((province) => (
            <path key={`${province.code}-line`} d={province.path} />
          ))}
        </g>
        <g className="province-labels">
          {mapData.provinces
            .filter((province) => provinceNames.has(province.name))
            .map((province) => (
              <text
                key={`${province.code}-label`}
                className={isZoomedOut || province.name === activeProvince ? "is-visible" : ""}
                x={province.label.x}
                y={province.label.y}
              >
                {province.name}
                <title>{`${province.name}：${provinceNames.get(province.name)} 家企业`}</title>
              </text>
            ))}
        </g>
        <g className="city-labels">
          {scale > 2.6 &&
            mapData.cities
              .filter((city) => projectCityNames.has(`${city.province}|${city.name}`) || projectCityNames.has(`${city.province}|${city.fullname}`))
              .map((city, index) => (
                <text key={`${city.province}-${city.name}-label-${index}`} x={city.x} y={city.y}>
                  {city.name}
                </text>
              ))}
        </g>
        <g className="project-points">
          {points.map((point) => {
            const active = selectedProject ? point.projectIds.includes(selectedProject.id) : false;
            const radius = active ? 5.6 : coordinateMode === "city" ? Math.min(5.2, 2.2 + point.count * 0.34) : 2.7;
            return (
              <g
                key={point.id}
                className="point-hit"
                role="button"
                tabIndex={0}
                aria-label={point.label}
                onClick={() => onSelectProject(point.projectId)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") onSelectProject(point.projectId);
                }}
              >
                <circle className={`project-dot ${active ? "is-active" : ""}`} cx={point.lng} cy={point.lat} r={radius / scale ** 0.15} />
              </g>
            );
          })}
          {selectedPoint && (
            <g className="target-marker" filter="url(#selectedGlow)">
              <circle cx={selectedPoint.x} cy={selectedPoint.y} r={7} />
              <circle cx={selectedPoint.x} cy={selectedPoint.y} r={12} />
              <circle cx={selectedPoint.x} cy={selectedPoint.y} r={20} />
            </g>
          )}
        </g>
      </svg>

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
