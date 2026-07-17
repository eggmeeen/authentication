import { lazy, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  Building2,
  ChevronDown,
  ChevronUp,
  Database,
  Layers3,
  ListFilter,
  Loader2,
  LocateFixed,
  MapPin,
  Moon,
  Search,
  Sun,
  X,
} from "lucide-react";
import type { ChinaMapDataset, CoordinateMode, ProjectDataset, ProjectRecord, ThemeMode } from "./types";

const WebGLMap = lazy(() => import("./WebGLMap"));

function normalizeText(value: string) {
  return value.toLowerCase().replace(/\s+/g, "");
}

function companyCode(project: ProjectRecord) {
  return String(project.id).padStart(3, "0");
}

function projectMatches(project: ProjectRecord, query: string) {
  const tokens = query.trim().split(/\s+/).filter(Boolean).map(normalizeText);
  if (!tokens.length) return true;
  const haystack = normalizeText([
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
  ].join(" "));

  return tokens.every((token) => {
    if (/^\d+$/.test(token)) return companyCode(project).includes(token) || normalizeText(project.sequence).includes(token);
    return haystack.includes(token);
  });
}

function EmptyState({ query }: { query: string }) {
  return (
    <div className="empty-state">
      <Search size={24} />
      <strong>没有匹配结果</strong>
      <span>{query}</span>
    </div>
  );
}

function ProjectRow({
  project,
  active,
  visibilityKey,
  onSelect,
}: {
  project: ProjectRecord;
  active: boolean;
  visibilityKey: string;
  onSelect: () => void;
}) {
  const rowRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (active) rowRef.current?.scrollIntoView({ block: "nearest", behavior: "auto" });
  }, [active, visibilityKey]);

  return (
    <button
      ref={rowRef}
      className={`project-row ${active ? "is-active" : ""}`}
      type="button"
      aria-pressed={active}
      data-project-id={project.id}
      onClick={onSelect}
    >
      <span className="row-top">
        <span className="row-index">{companyCode(project)}</span>
        <span className="row-place">
          {project.displayCityLabel || project.displayCity}
          {project.district ? ` · ${project.district}` : ""}
        </span>
      </span>
      <strong><Building2 size={14} />{project.company}</strong>
      <span className="row-address">{project.address}</span>
      {active && (
        <span className="row-meta">
          <span>坐标层级 <b>{project.coordinateLevel === "district" ? "区县级" : "地级"}</b></span>
          <span>{project.addressCoord ? `${project.addressCoord.lat.toFixed(4)}°N, ${project.addressCoord.lng.toFixed(4)}°E` : "暂无精确坐标"}</span>
        </span>
      )}
    </button>
  );
}

export default function App() {
  const [dataset, setDataset] = useState<ProjectDataset | null>(null);
  const [mapData, setMapData] = useState<ChinaMapDataset | null>(null);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [coordinateMode, setCoordinateMode] = useState<CoordinateMode>("city");
  const [theme, setTheme] = useState<ThemeMode>("night");
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
      .catch((error: unknown) => setLoadError(error instanceof Error ? error.message : String(error)));
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

  useEffect(() => {
    document.documentElement.style.colorScheme = theme === "night" ? "dark" : "light";
  }, [theme]);

  const filteredProjects = useMemo(() => {
    if (!dataset) return [];
    return dataset.projects.filter((project) => projectMatches(project, deferredQuery));
  }, [dataset, deferredQuery]);

  const visibleProjects = deferredQuery.trim() ? filteredProjects : dataset?.projects ?? [];
  const isSearchPending = query !== deferredQuery;
  const hasQuery = query.trim().length > 0;
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

  const updateQuery = useCallback((value: string) => {
    setQuery(value);
    if (!dataset || !value.trim()) return;
    setSelectedProjectId((current) => {
      if (!current) return current;
      const selected = dataset.projects.find((project) => project.id === current);
      return selected && projectMatches(selected, value) ? current : null;
    });
  }, [dataset]);

  if (loadError) {
    return (
      <main className="loading-page">
        <Database size={30} />
        <strong>数据加载失败</strong>
        <span>{loadError}</span>
      </main>
    );
  }

  if (!dataset || !mapData) {
    return (
      <main className="loading-page">
        <Loader2 className="spin" size={30} />
        <strong>正在加载本地地图数据库</strong>
      </main>
    );
  }

  const districtCount = dataset.metadata.matchMethods.district ?? 0;
  const prefectureCount = dataset.metadata.matchMethods.prefecture ?? 0;
  const nextTheme = theme === "night" ? "day" : "night";
  const selectedRowVisibilityKey = `${deferredQuery.trim() || "all"}:${visibleProjects.length}:${isMobileLayout ? mobileDrawerExpanded : "desktop"}`;

  return (
    <main className={`app-shell theme-${theme}`}>
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark"><MapPin size={21} /></div>
          <div>
            <h1>认证项目多场所地图</h1>
            <p>China certification project atlas</p>
          </div>
        </div>

        <div className="search-box top-search">
          <Search size={17} />
          <input
            value={query}
            onChange={(event) => updateQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && query.trim()) {
                const firstMatch = dataset.projects.find((project) => projectMatches(project, query));
                if (firstMatch) onSelectProject(firstMatch.id);
              }
              if (event.key === "Escape") clearSearch();
            }}
            placeholder="搜索编号、公司、城市、地址"
            aria-label="搜索编号、公司、城市、地址"
          />
          {hasQuery && <span className="search-count">{isSearchPending ? <Loader2 className="spin" size={13} /> : `${filteredProjects.length} 条`}</span>}
          {hasQuery && <button className="clear-button" type="button" onClick={clearSearch} aria-label="清除搜索"><X size={14} /></button>}
        </div>

        <div className="segmented" aria-label="坐标模式">
          <button className={coordinateMode === "city" ? "is-active" : ""} type="button" onClick={() => setCoordinateMode("city")}>
            <Layers3 size={15} /> 地级市
          </button>
          <button className={coordinateMode === "address" ? "is-active" : ""} type="button" onClick={() => setCoordinateMode("address")}>
            <LocateFixed size={15} /> 区县级
          </button>
        </div>

        <div className="stat-strip" aria-label="数据概览">
          <div><strong>{dataset.metadata.extractedProjects}</strong><span>项目</span></div>
          <div><strong>{dataset.metadata.uniquePlaces}</strong><span>地点</span></div>
          <div><strong>{districtCount}</strong><span>区县级</span></div>
          <div><strong>{prefectureCount}</strong><span>地级</span></div>
        </div>

        <button
          className="theme-toggle"
          type="button"
          onClick={() => setTheme(nextTheme)}
          aria-label={`切换到${nextTheme === "day" ? "日间" : "黑夜"}模式`}
        >
          {nextTheme === "day" ? <Sun size={16} /> : <Moon size={16} />}
          {nextTheme === "day" ? "日间" : "黑夜"}
        </button>
      </header>

      <section className={`workspace ${isMobileLayout ? "is-mobile" : ""} ${mobileDrawerExpanded ? "drawer-expanded" : "drawer-collapsed"}`}>
        <section className="visual-pane">
          <Suspense fallback={<div className="map-loading"><Loader2 className="spin" size={24} /><span>正在初始化 WebGL 地图</span></div>}>
            <WebGLMap
              projects={visibleProjects}
              selectedProject={selectedProject}
              coordinateMode={coordinateMode}
              theme={theme}
              mapData={mapData}
              onSelectProject={onSelectProject}
              onClearSelection={() => setSelectedProjectId(null)}
            />
          </Suspense>
        </section>

        <aside className="side-panel">
          <div className="panel-grip" aria-hidden="true" />
          <div className="panel-head">
            <div>
              <span className="eyebrow"><ListFilter size={14} /> 项目清单</span>
              <h2>{visibleProjects.length} 条记录</h2>
            </div>
            <div className="panel-head-actions">
              {isMobileLayout && (
                <button
                  className="drawer-toggle"
                  type="button"
                  onClick={() => setMobileDrawerExpanded((current) => !current)}
                  aria-label={mobileDrawerExpanded ? "收起项目清单" : "展开项目清单"}
                >
                  {mobileDrawerExpanded ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
                  {mobileDrawerExpanded ? "收起" : "展开"}
                </button>
              )}
              <div className="db-badge"><Database size={13} /> 本地数据</div>
            </div>
          </div>

          <div className={`selection-summary ${selectedProject ? "has-selection" : ""}`}>
            {selectedProject ? (
              <>
                <span className="selection-project-meta">{companyCode(selectedProject)} · {selectedProject.displayCityLabel}</span>
                <strong className="selection-project-name">{selectedProject.company}</strong>
                <button className="selection-clear" type="button" onClick={() => setSelectedProjectId(null)} aria-label="清除已选公司"><X size={13} /></button>
              </>
            ) : (
              <>
                <span>{hasQuery ? "搜索结果" : "全部项目"}</span>
                <strong>{visibleProjects.length}</strong>
              </>
            )}
          </div>

          <div className="project-list">
            {visibleProjects.length ? visibleProjects.map((project) => (
              <ProjectRow
                key={project.id}
                project={project}
                active={project.id === selectedProject?.id}
                visibilityKey={selectedRowVisibilityKey}
                onSelect={() => onSelectProject(project.id)}
              />
            )) : <EmptyState query={query} />}
          </div>

          <div className="coordinate-note">当前坐标用于地图定位和跳转，不代表门牌级精确坐标。</div>
        </aside>
      </section>
    </main>
  );
}
