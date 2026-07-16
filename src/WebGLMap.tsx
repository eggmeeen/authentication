import { Html, MapControls, Sparkles, useCursor } from "@react-three/drei";
import { Canvas, type ThreeEvent, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Color,
  DoubleSide,
  ExtrudeGeometry,
  Group,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  ShaderMaterial,
  Vector3,
} from "three";
import { SVGLoader } from "three/examples/jsm/loaders/SVGLoader.js";
import { CircleHelp, LocateFixed, Minus, MousePointer2, Plus, RotateCcw, X } from "lucide-react";
import type { ChinaMapDataset, ChinaMapProvince, CoordinateMode, Coord, ProjectRecord, ThemeMode } from "./types";

const MAP_SCALE = 0.0182;
const MAX_ZOOM = 20;
const MAX_CAMERA_DISTANCE = 92;

function overviewDistanceForAspect(aspect: number) {
  return Math.min(84, Math.max(35, (35 * 0.95) / Math.max(0.42, aspect)));
}

interface WebGLMapProps {
  projects: ProjectRecord[];
  selectedProject: ProjectRecord | null;
  coordinateMode: CoordinateMode;
  theme: ThemeMode;
  mapData: ChinaMapDataset;
  onSelectProject: (projectId: number) => void;
  onClearSelection: () => void;
}

interface ViewCommand {
  id: number;
  type: "in" | "out" | "reset";
}

function coordFor(project: ProjectRecord, mode: CoordinateMode): Coord | null {
  if (mode === "address" && project.addressCoord) return project.addressCoord;
  return project.cityCoord ?? project.addressCoord;
}

function mercator(lng: number, lat: number) {
  const clampedLat = Math.max(-85, Math.min(85, lat));
  return {
    x: (lng * Math.PI) / 180,
    y: Math.log(Math.tan(Math.PI / 4 + (clampedLat * Math.PI) / 360)),
  };
}

function projectMapPoint(coord: Coord, mapData: ChinaMapDataset) {
  const projection = mapData.metadata.projection;
  const point = mercator(coord.lng, coord.lat);
  return {
    x: mapData.metadata.padding + (point.x - projection.minX) * projection.scale,
    y: projection.yOffset + (projection.maxY - point.y) * projection.scale,
  };
}

function mapPointToWorld(x: number, y: number, mapData: ChinaMapDataset, z = 0) {
  return new Vector3(
    (x - mapData.metadata.width / 2) * MAP_SCALE,
    (mapData.metadata.height / 2 - y) * MAP_SCALE,
    z,
  );
}

function projectWorldPoint(project: ProjectRecord, mode: CoordinateMode, mapData: ChinaMapDataset, z = 0.42) {
  const coord = coordFor(project, mode);
  if (!coord) return null;
  const point = projectMapPoint(coord, mapData);
  return mapPointToWorld(point.x, point.y, mapData, z);
}

function companyCode(project: ProjectRecord) {
  return String(project.id).padStart(3, "0");
}

function provinceGeometry(path: string) {
  const loader = new SVGLoader();
  const svg = loader.parse(`<svg xmlns="http://www.w3.org/2000/svg"><path d="${path}" fill="#fff" /></svg>`);
  const shapes = svg.paths.flatMap((item) => item.toShapes());
  const geometry = new ExtrudeGeometry(shapes, {
    depth: 12,
    bevelEnabled: true,
    bevelSegments: 2,
    bevelSize: 1.5,
    bevelThickness: 1.2,
    curveSegments: 2,
  });
  geometry.computeVertexNormals();
  return geometry;
}

function ProvinceMesh({
  province,
  index,
  selected,
  theme,
  reducedMotion,
  onSelect,
}: {
  province: ChinaMapProvince;
  index: number;
  selected: boolean;
  theme: ThemeMode;
  reducedMotion: boolean;
  onSelect: () => void;
}) {
  const meshRef = useRef<Mesh<ExtrudeGeometry, MeshStandardMaterial>>(null);
  const [hovered, setHovered] = useState(false);
  const geometry = useMemo(() => provinceGeometry(province.path), [province.path]);
  const night = theme === "night";
  const baseColors = night ? ["#102d3c", "#123342", "#0d2939", "#173746"] : ["#edf3ff", "#f7f9ff", "#e7efff", "#f1f5ff"];
  useCursor(hovered);

  useEffect(() => () => geometry.dispose(), [geometry]);

  useFrame((_, delta) => {
    if (!meshRef.current) return;
    const destination = selected ? 15 : hovered ? 8 : 0;
    const speed = reducedMotion ? 1 : 1 - Math.exp(-delta * 10);
    meshRef.current.position.z += (destination - meshRef.current.position.z) * speed;
  });

  return (
    <mesh
      ref={meshRef}
      geometry={geometry}
      onClick={(event) => {
        event.stopPropagation();
        onSelect();
      }}
      onPointerEnter={(event) => {
        event.stopPropagation();
        setHovered(true);
      }}
      onPointerLeave={() => setHovered(false)}
    >
      <meshStandardMaterial
        color={selected ? (night ? "#245342" : "#fff2eb") : baseColors[index % baseColors.length]}
        emissive={selected || hovered ? (night ? "#4df58a" : "#ff5d35") : night ? "#05212c" : "#dce7ff"}
        emissiveIntensity={selected ? 0.42 : hovered ? 0.2 : 0.04}
        metalness={night ? 0.36 : 0.08}
        roughness={night ? 0.56 : 0.82}
        side={DoubleSide}
      />
      <lineSegments>
        <edgesGeometry args={[geometry, 25]} />
        <lineBasicMaterial color={selected ? (night ? "#c9ffda" : "#ff5d35") : night ? "#9fc3ba" : "#3970ff"} transparent opacity={selected ? 0.96 : 0.62} />
      </lineSegments>
    </mesh>
  );
}

function ProvinceLayer({
  mapData,
  selectedProvince,
  theme,
  reducedMotion,
  onSelectProvince,
}: {
  mapData: ChinaMapDataset;
  selectedProvince: string | null;
  theme: ThemeMode;
  reducedMotion: boolean;
  onSelectProvince: (name: string) => void;
}) {
  return (
    <group
      scale={[MAP_SCALE, -MAP_SCALE, MAP_SCALE]}
      position={[-(mapData.metadata.width * MAP_SCALE) / 2, (mapData.metadata.height * MAP_SCALE) / 2, 0]}
    >
      {mapData.provinces.map((province, index) => (
        <ProvinceMesh
          key={province.code}
          province={province}
          index={index}
          selected={selectedProvince === province.name}
          theme={theme}
          reducedMotion={reducedMotion}
          onSelect={() => onSelectProvince(province.name)}
        />
      ))}
    </group>
  );
}

function ProjectInstances({
  projects,
  coordinateMode,
  mapData,
  theme,
  reducedMotion,
  onSelectProject,
}: {
  projects: ProjectRecord[];
  coordinateMode: CoordinateMode;
  mapData: ChinaMapDataset;
  theme: ThemeMode;
  reducedMotion: boolean;
  onSelectProject: (projectId: number) => void;
}) {
  const meshRef = useRef<InstancedMesh>(null);
  const materialRef = useRef<MeshBasicMaterial>(null);
  const lastMarkerScaleRef = useRef(1);
  const dummy = useMemo(() => new Object3D(), []);
  const [hovered, setHovered] = useState<number | null>(null);
  const locatedProjects = useMemo(
    () => projects.map((project) => ({ project, position: projectWorldPoint(project, coordinateMode, mapData) })).filter((item): item is { project: ProjectRecord; position: Vector3 } => Boolean(item.position)),
    [coordinateMode, mapData, projects],
  );
  useCursor(hovered !== null);

  useLayoutEffect(() => {
    if (!meshRef.current) return;
    locatedProjects.forEach(({ position }, index) => {
      dummy.position.copy(position);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      meshRef.current?.setMatrixAt(index, dummy.matrix);
    });
    meshRef.current.count = locatedProjects.length;
    meshRef.current.instanceMatrix.needsUpdate = true;
    meshRef.current.computeBoundingSphere();
  }, [dummy, locatedProjects]);

  useFrame(({ camera, clock, size }) => {
    const overviewDistance = overviewDistanceForAspect(size.width / Math.max(1, size.height));
    const markerScale = Math.max(0.18, Math.min(1, Math.abs(camera.position.z) / overviewDistance));

    if (meshRef.current && Math.abs(markerScale - lastMarkerScaleRef.current) > 0.012) {
      locatedProjects.forEach(({ position }, index) => {
        dummy.position.copy(position);
        dummy.scale.setScalar(markerScale);
        dummy.updateMatrix();
        meshRef.current?.setMatrixAt(index, dummy.matrix);
      });
      meshRef.current.instanceMatrix.needsUpdate = true;
      lastMarkerScaleRef.current = markerScale;
    }

    if (materialRef.current && !reducedMotion) {
      materialRef.current.opacity = 0.78 + Math.sin(clock.elapsedTime * 1.35) * 0.16;
    }
  });

  if (!locatedProjects.length) return null;

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, Math.max(1, locatedProjects.length)]}
      onClick={(event: ThreeEvent<MouseEvent>) => {
        event.stopPropagation();
        if (event.instanceId === undefined) return;
        const record = locatedProjects[event.instanceId];
        if (record) onSelectProject(record.project.id);
      }}
      onPointerMove={(event: ThreeEvent<PointerEvent>) => {
        event.stopPropagation();
        setHovered(event.instanceId ?? null);
      }}
      onPointerOut={() => setHovered(null)}
    >
      <sphereGeometry args={[0.052, 9, 9]} />
      <meshBasicMaterial ref={materialRef} color={theme === "night" ? "#83ff9d" : "#245dff"} transparent opacity={0.88} toneMapped={false} />
    </instancedMesh>
  );
}

function SelectedBeacon({
  project,
  coordinateMode,
  mapData,
  theme,
  reducedMotion,
  onClearSelection,
}: {
  project: ProjectRecord | null;
  coordinateMode: CoordinateMode;
  mapData: ChinaMapDataset;
  theme: ThemeMode;
  reducedMotion: boolean;
  onClearSelection: () => void;
}) {
  const groupRef = useRef<Group>(null);
  const ringRef = useRef<Mesh>(null);
  const ringMaterialRef = useRef<MeshBasicMaterial>(null);
  const position = useMemo(
    () => (project ? projectWorldPoint(project, coordinateMode, mapData, 0.58) : null),
    [coordinateMode, mapData, project],
  );

  useFrame(({ camera, clock, size }) => {
    const overviewDistance = overviewDistanceForAspect(size.width / Math.max(1, size.height));
    const beaconScale = Math.max(0.18, Math.min(1, Math.abs(camera.position.z) / overviewDistance));
    groupRef.current?.scale.setScalar(beaconScale);

    if (ringRef.current && ringMaterialRef.current && !reducedMotion) {
      const progress = (clock.elapsedTime * 0.56) % 1;
      ringRef.current.scale.setScalar(0.65 + progress * 1.9);
      ringMaterialRef.current.opacity = 0.72 * (1 - progress);
    }
  });

  if (!project || !position) return null;
  const accent = theme === "night" ? "#a5ffbd" : "#ff5d35";

  return (
    <group ref={groupRef} position={position}>
      <mesh>
        <sphereGeometry args={[0.105, 16, 16]} />
        <meshBasicMaterial color={accent} toneMapped={false} />
      </mesh>
      <mesh ref={ringRef}>
        <ringGeometry args={[0.11, 0.145, 40]} />
        <meshBasicMaterial ref={ringMaterialRef} color={accent} transparent opacity={0.7} side={DoubleSide} toneMapped={false} />
      </mesh>
      <pointLight color={accent} intensity={1.8} distance={3.8} />
      <Html position={[0.18, 0.18, 0]} center={false} zIndexRange={[100, 0]}>
        <article className="map-callout">
          <button type="button" aria-label="关闭项目详情" onClick={onClearSelection}><X size={13} /></button>
          <span>{companyCode(project)} · {project.displayCityLabel || project.displayCity}</span>
          <strong>{project.company}</strong>
          <small>{project.district || project.prefectureCommon}</small>
        </article>
      </Html>
    </group>
  );
}

function ProvinceLabels({ mapData, selectedProvince }: { mapData: ChinaMapDataset; selectedProvince: string | null }) {
  const labels = useMemo(() => {
    const ranked = [...mapData.provinces].filter((province) => province.count > 0).sort((a, b) => b.count - a.count);
    const visible = ranked.slice(0, 20);
    const selected = mapData.provinces.find((province) => province.name === selectedProvince);
    if (selected && !visible.includes(selected)) visible.push(selected);
    return visible;
  }, [mapData, selectedProvince]);

  return (
    <>
      {labels.map((province) => {
        const position = mapPointToWorld(province.label.x, province.label.y, mapData, selectedProvince === province.name ? 0.9 : 0.5);
        return (
          <Html key={province.code} position={position} center zIndexRange={[40, 0]}>
            <span className={`province-label ${selectedProvince === province.name ? "is-active" : ""}`}>
              {province.name}<b>{province.count}</b>
            </span>
          </Html>
        );
      })}
    </>
  );
}

const fieldVertexShader = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fieldFragmentShader = `
  varying vec2 vUv;
  uniform float uTime;
  uniform float uMotion;
  uniform vec3 uColor;

  float line(float value, float width) {
    return smoothstep(width, 0.0, abs(fract(value) - 0.5));
  }

  void main() {
    vec2 uv = vUv;
    float grid = line(uv.x * 18.0, 0.035) + line(uv.y * 13.0, 0.035);
    float wave = sin(uv.x * 22.0 + uv.y * 7.0 - uTime * 0.16 * uMotion) * 0.5 + 0.5;
    float drift = sin(uv.y * 36.0 - uv.x * 5.0 + uTime * 0.11 * uMotion) * 0.5 + 0.5;
    float vignette = smoothstep(0.78, 0.12, distance(uv, vec2(0.5)));
    float alpha = (grid * 0.045 + wave * drift * 0.035) * vignette;
    gl_FragColor = vec4(uColor, alpha);
  }
`;

function NetworkField({ theme, reducedMotion }: { theme: ThemeMode; reducedMotion: boolean }) {
  const materialRef = useRef<ShaderMaterial>(null);
  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uMotion: { value: reducedMotion ? 0 : 1 },
      uColor: { value: new Color(theme === "night" ? "#5af2bd" : "#245dff") },
    }),
    [reducedMotion, theme],
  );

  useEffect(() => {
    if (!materialRef.current) return;
    materialRef.current.uniforms.uColor.value.set(theme === "night" ? "#5af2bd" : "#245dff");
    materialRef.current.uniforms.uMotion.value = reducedMotion ? 0 : 1;
  }, [reducedMotion, theme]);

  useFrame(({ clock }) => {
    if (materialRef.current) materialRef.current.uniforms.uTime.value = clock.elapsedTime;
  });

  return (
    <mesh position={[0, 0, -1.3]}>
      <planeGeometry args={[37, 27, 1, 1]} />
      <shaderMaterial ref={materialRef} vertexShader={fieldVertexShader} fragmentShader={fieldFragmentShader} uniforms={uniforms} transparent depthWrite={false} />
    </mesh>
  );
}

function CameraRig({
  selectedProject,
  selectedProvince,
  coordinateMode,
  mapData,
  command,
  reducedMotion,
  onZoomChange,
}: {
  selectedProject: ProjectRecord | null;
  selectedProvince: string | null;
  coordinateMode: CoordinateMode;
  mapData: ChinaMapDataset;
  command: ViewCommand;
  reducedMotion: boolean;
  onZoomChange: (zoom: number) => void;
}) {
  const controlsRef = useRef<React.ElementRef<typeof MapControls>>(null);
  const { camera, size } = useThree();
  const aspect = size.width / Math.max(1, size.height);
  const resetDistance = overviewDistanceForAspect(aspect);
  const minDistance = resetDistance / MAX_ZOOM;
  const lastZoomRef = useRef(1);
  const animationRef = useRef<{
    progress: number;
    fromPosition: Vector3;
    toPosition: Vector3;
    fromTarget: Vector3;
    toTarget: Vector3;
  } | null>(null);

  const animateTo = (target: Vector3, distance: number) => {
    const controls = controlsRef.current;
    const currentTarget = controls?.target.clone() ?? new Vector3();
    const toPosition = new Vector3(target.x, target.y - 0.3, distance);
    animationRef.current = {
      progress: 0,
      fromPosition: camera.position.clone(),
      toPosition,
      fromTarget: currentTarget,
      toTarget: target,
    };
  };

  useEffect(() => {
    if (selectedProject) {
      const position = projectWorldPoint(selectedProject, coordinateMode, mapData, 0);
      if (position) animateTo(position, aspect < 0.75 ? 34 : 21.5);
      return;
    }
    if (selectedProvince) {
      const province = mapData.provinces.find((item) => item.name === selectedProvince);
      if (province) animateTo(mapPointToWorld(province.label.x, province.label.y, mapData), aspect < 0.75 ? 42 : 25.5);
    }
  }, [aspect, coordinateMode, mapData, selectedProject, selectedProvince]);

  useEffect(() => {
    if (!selectedProject && !selectedProvince) animateTo(new Vector3(0, 0, 0), resetDistance);
  }, [resetDistance]);

  useEffect(() => {
    if (!command.id) return;
    const controls = controlsRef.current;
    const target = controls?.target.clone() ?? new Vector3();
    if (command.type === "reset") {
      animateTo(new Vector3(0, 0, 0), resetDistance);
      return;
    }
    const relative = camera.position.clone().sub(target);
    const factor = command.type === "in" ? 0.58 : 1.62;
    const nextDistance = Math.max(minDistance, Math.min(MAX_CAMERA_DISTANCE, relative.length() * factor));
    const toPosition = target.clone().add(relative.setLength(nextDistance));
    animationRef.current = {
      progress: 0,
      fromPosition: camera.position.clone(),
      toPosition,
      fromTarget: target.clone(),
      toTarget: target,
    };
  }, [camera, command, minDistance, resetDistance]);

  useFrame((_, delta) => {
    const animation = animationRef.current;
    const controls = controlsRef.current;
    if (!controls) return;

    if (animation) {
      animation.progress = reducedMotion ? 1 : Math.min(1, animation.progress + delta * 2.5);
      const t = 1 - Math.pow(1 - animation.progress, 3);
      camera.position.lerpVectors(animation.fromPosition, animation.toPosition, t);
      controls.target.lerpVectors(animation.fromTarget, animation.toTarget, t);
      controls.update();
      if (animation.progress >= 1) animationRef.current = null;
    }

    const zoom = Math.min(MAX_ZOOM, Math.max(0.1, resetDistance / camera.position.distanceTo(controls.target)));
    const roundedZoom = Math.round(zoom * 10) / 10;
    if (Math.abs(roundedZoom - lastZoomRef.current) >= 0.1) {
      lastZoomRef.current = roundedZoom;
      onZoomChange(roundedZoom);
    }
  });

  return (
    <MapControls
      ref={controlsRef}
      enableRotate={false}
      enableDamping={!reducedMotion}
      dampingFactor={0.08}
      minDistance={minDistance}
      maxDistance={MAX_CAMERA_DISTANCE}
      zoomSpeed={1.4}
      zoomToCursor
      screenSpacePanning
    />
  );
}

function Scene({
  projects,
  selectedProject,
  coordinateMode,
  theme,
  mapData,
  selectedProvince,
  command,
  reducedMotion,
  onSelectProvince,
  onSelectProject,
  onClearSelection,
  onZoomChange,
}: WebGLMapProps & {
  selectedProvince: string | null;
  command: ViewCommand;
  reducedMotion: boolean;
  onSelectProvince: (name: string) => void;
  onZoomChange: (zoom: number) => void;
}) {
  const night = theme === "night";
  return (
    <>
      <color attach="background" args={[night ? "#03111f" : "#f8faff"]} />
      <fog attach="fog" args={[night ? "#03111f" : "#f8faff", 45, 110]} />
      <ambientLight intensity={night ? 0.72 : 1.35} />
      <directionalLight position={[-8, -4, 18]} intensity={night ? 2.6 : 2.2} color={night ? "#c6ffe0" : "#ffffff"} />
      <directionalLight position={[12, 8, 10]} intensity={0.9} color={night ? "#4aa3ff" : "#7ca1ff"} />
      <NetworkField theme={theme} reducedMotion={reducedMotion} />
      {!reducedMotion && <Sparkles count={90} scale={[20, 15, 1.2]} size={1.4} speed={0.12} color={night ? "#8dffc2" : "#245dff"} opacity={night ? 0.32 : 0.15} position={[0, 0, -0.35]} />}
      <ProvinceLayer mapData={mapData} selectedProvince={selectedProvince} theme={theme} reducedMotion={reducedMotion} onSelectProvince={onSelectProvince} />
      <ProjectInstances projects={projects} coordinateMode={coordinateMode} mapData={mapData} theme={theme} reducedMotion={reducedMotion} onSelectProject={onSelectProject} />
      <SelectedBeacon project={selectedProject} coordinateMode={coordinateMode} mapData={mapData} theme={theme} reducedMotion={reducedMotion} onClearSelection={onClearSelection} />
      <ProvinceLabels mapData={mapData} selectedProvince={selectedProvince} />
      <CameraRig selectedProject={selectedProject} selectedProvince={selectedProvince} coordinateMode={coordinateMode} mapData={mapData} command={command} reducedMotion={reducedMotion} onZoomChange={onZoomChange} />
    </>
  );
}

function StaticMapFallback({ mapData, projects, coordinateMode, theme }: Pick<WebGLMapProps, "mapData" | "projects" | "coordinateMode" | "theme">) {
  return (
    <svg className="static-map-fallback" viewBox={`0 0 ${mapData.metadata.width} ${mapData.metadata.height}`} role="img" aria-label="中国认证项目分布地图">
      {mapData.provinces.map((province) => <path key={province.code} d={province.path} />)}
      {projects.map((project) => {
        const coord = coordFor(project, coordinateMode);
        if (!coord) return null;
        const point = projectMapPoint(coord, mapData);
        return <circle key={project.id} cx={point.x} cy={point.y} r={theme === "night" ? 2.6 : 2.2} />;
      })}
    </svg>
  );
}

function webGLAvailable() {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

export default function WebGLMap(props: WebGLMapProps) {
  const [selectedProvince, setSelectedProvince] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(true);
  const [command, setCommand] = useState<ViewCommand>({ id: 0, type: "reset" });
  const [zoomLevel, setZoomLevel] = useState(1);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const canRenderWebGL = useMemo(webGLAvailable, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReducedMotion(media.matches);
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  const issueCommand = (type: ViewCommand["type"]) => {
    if (type === "reset") {
      setSelectedProvince(null);
      props.onClearSelection();
    }
    setCommand((current) => ({ id: current.id + 1, type }));
  };

  return (
    <div className="webgl-map">
      {canRenderWebGL ? (
        <Canvas
          dpr={[1, 1.65]}
          camera={{ position: [0, -0.4, 38], fov: 30, near: 0.1, far: 200 }}
          gl={{ antialias: true, alpha: false, powerPreference: "high-performance" }}
          onPointerMissed={() => props.onClearSelection()}
          fallback={<StaticMapFallback mapData={props.mapData} projects={props.projects} coordinateMode={props.coordinateMode} theme={props.theme} />}
        >
          <Scene
            {...props}
            selectedProvince={selectedProvince}
            command={command}
            reducedMotion={reducedMotion}
            onZoomChange={setZoomLevel}
            onSelectProvince={(name) => setSelectedProvince((current) => (current === name ? null : name))}
          />
        </Canvas>
      ) : (
        <StaticMapFallback mapData={props.mapData} projects={props.projects} coordinateMode={props.coordinateMode} theme={props.theme} />
      )}

      <div className="map-precision-badge"><LocateFixed size={14} /> WebGL 高精度矢量图</div>

      <div className="map-help">
        <button type="button" className="map-help-toggle" onClick={() => setShowHelp((current) => !current)} aria-expanded={showHelp}>
          <CircleHelp size={15} /> 地图使用说明
        </button>
        {showHelp && (
          <div className="map-help-body">
            <span><MousePointer2 size={13} />拖拽移动 · 滚轮缩放 · 最高 20×</span>
            <span><i className="legend-dot" />光点为项目，数字为省级数量</span>
            <span><i className="legend-label" />点击省域或项目进入聚焦视图</span>
          </div>
        )}
      </div>

      <div className="map-scale-bar" aria-hidden="true">
        <div><span>0</span><span>250</span><span>500 km</span></div>
        <i />
      </div>

      <div className="map-controls" aria-label="地图缩放">
        <button type="button" onClick={() => issueCommand("in")} aria-label="放大地图" title="放大地图（最高 20×）"><Plus size={18} /></button>
        <button type="button" onClick={() => issueCommand("out")} aria-label="缩小地图"><Minus size={18} /></button>
        <button type="button" onClick={() => issueCommand("reset")} aria-label="显示全国"><RotateCcw size={15} /> 全国</button>
      </div>

      <div className="map-status" aria-live="polite"><span /> {selectedProvince || (props.selectedProject ? props.selectedProject.displayCityLabel : "全国")} · {zoomLevel.toFixed(1)}×</div>
    </div>
  );
}
