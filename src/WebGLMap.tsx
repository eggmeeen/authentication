import { Html, MapControls, Sparkles, useCursor } from "@react-three/drei";
import { Canvas, type ThreeEvent, useFrame, useThree } from "@react-three/fiber";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
const COMPANY_LABEL_ZOOM = 4;
const CLICK_DRAG_TOLERANCE = 5;

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

interface LocatedProject {
  project: ProjectRecord;
  position: Vector3;
}

interface ProjectLabelLayout extends LocatedProject {
  groupIndex: number;
  groupSize: number;
  groupHasSelected: boolean;
}

function isIntentionalClick(event: ThreeEvent<MouseEvent>) {
  return event.delta <= CLICK_DRAG_TOLERANCE;
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
      onClick={(event: ThreeEvent<MouseEvent>) => {
        event.stopPropagation();
        if (!isIntentionalClick(event)) return;
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
  locatedProjects,
  theme,
  reducedMotion,
  onSelectProject,
}: {
  locatedProjects: LocatedProject[];
  theme: ThemeMode;
  reducedMotion: boolean;
  onSelectProject: (projectId: number) => void;
}) {
  const meshRef = useRef<InstancedMesh>(null);
  const hitMeshRef = useRef<InstancedMesh>(null);
  const materialRef = useRef<MeshBasicMaterial>(null);
  const lastMarkerScaleRef = useRef(1);
  const dummy = useMemo(() => new Object3D(), []);
  const [hovered, setHovered] = useState<number | null>(null);
  useCursor(hovered !== null);

  useLayoutEffect(() => {
    if (!meshRef.current || !hitMeshRef.current) return;
    locatedProjects.forEach(({ position }, index) => {
      dummy.position.copy(position);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      meshRef.current?.setMatrixAt(index, dummy.matrix);
      hitMeshRef.current?.setMatrixAt(index, dummy.matrix);
    });
    meshRef.current.count = locatedProjects.length;
    hitMeshRef.current.count = locatedProjects.length;
    meshRef.current.instanceMatrix.needsUpdate = true;
    hitMeshRef.current.instanceMatrix.needsUpdate = true;
    meshRef.current.computeBoundingSphere();
    hitMeshRef.current.computeBoundingSphere();
  }, [dummy, locatedProjects]);

  useFrame(({ camera, clock, size }) => {
    const overviewDistance = overviewDistanceForAspect(size.width / Math.max(1, size.height));
    const markerScale = Math.max(0.18, Math.min(1, Math.abs(camera.position.z) / overviewDistance));

    if (meshRef.current && hitMeshRef.current && Math.abs(markerScale - lastMarkerScaleRef.current) > 0.012) {
      locatedProjects.forEach(({ position }, index) => {
        dummy.position.copy(position);
        dummy.scale.setScalar(markerScale);
        dummy.updateMatrix();
        meshRef.current?.setMatrixAt(index, dummy.matrix);
        hitMeshRef.current?.setMatrixAt(index, dummy.matrix);
      });
      meshRef.current.instanceMatrix.needsUpdate = true;
      hitMeshRef.current.instanceMatrix.needsUpdate = true;
      lastMarkerScaleRef.current = markerScale;
    }

    if (materialRef.current && !reducedMotion) {
      materialRef.current.opacity = 0.78 + Math.sin(clock.elapsedTime * 1.35) * 0.16;
    }
  });

  if (!locatedProjects.length) return null;

  const hoveredProject = hovered === null ? null : locatedProjects[hovered];

  return (
    <>
      <instancedMesh ref={meshRef} args={[undefined, undefined, Math.max(1, locatedProjects.length)]}>
        <sphereGeometry args={[0.06, 9, 9]} />
        <meshBasicMaterial ref={materialRef} color={theme === "night" ? "#83ff9d" : "#245dff"} transparent opacity={0.88} toneMapped={false} />
      </instancedMesh>
      <instancedMesh
        ref={hitMeshRef}
        args={[undefined, undefined, Math.max(1, locatedProjects.length)]}
        onClick={(event: ThreeEvent<MouseEvent>) => {
          event.stopPropagation();
          if (!isIntentionalClick(event) || event.instanceId === undefined) return;
          const record = locatedProjects[event.instanceId];
          if (record) onSelectProject(record.project.id);
        }}
        onPointerMove={(event: ThreeEvent<PointerEvent>) => {
          event.stopPropagation();
          setHovered(event.instanceId ?? null);
        }}
        onPointerOut={() => setHovered(null)}
      >
        <sphereGeometry args={[0.18, 8, 8]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} colorWrite={false} />
      </instancedMesh>
      {hoveredProject ? (
        <Html position={hoveredProject.position} zIndexRange={[9, 0]} style={{ pointerEvents: "none" }}>
          <span className="project-hover-label"><b>{companyCode(hoveredProject.project)}</b>{hoveredProject.project.company}</span>
        </Html>
      ) : null}
    </>
  );
}

const ProjectLabels = memo(function ProjectLabels({
  locatedProjects,
  visible,
  zoomLevel,
  buttonRefs,
  selectedProjectId,
}: {
  locatedProjects: LocatedProject[];
  visible: boolean;
  zoomLevel: number;
  buttonRefs: { current: Map<number, HTMLButtonElement> };
  selectedProjectId: number | null;
}) {
  const projectedPointRef = useRef(new Vector3());
  const wasVisibleRef = useRef(false);
  const labelLayouts = useMemo<ProjectLabelLayout[]>(() => {
    const groups = new Map<string, LocatedProject[]>();
    locatedProjects.forEach((item) => {
      const key = `${item.position.x.toFixed(4)}:${item.position.y.toFixed(4)}`;
      const group = groups.get(key);
      if (group) group.push(item);
      else groups.set(key, [item]);
    });

    const layouts: ProjectLabelLayout[] = [];
    groups.forEach((group) => {
      const groupHasSelected = group.some((item) => item.project.id === selectedProjectId);
      group.forEach((item, index) => {
        layouts.push({
          ...item,
          groupIndex: index,
          groupSize: group.length,
          groupHasSelected,
        });
      });
    });
    return layouts;
  }, [locatedProjects, selectedProjectId]);

  useLayoutEffect(() => {
    buttonRefs.current.forEach((button) => { button.hidden = true; });
    wasVisibleRef.current = false;
  }, [labelLayouts]);

  useFrame(({ camera, size }) => {
    if (!visible) {
      if (wasVisibleRef.current) buttonRefs.current.forEach((button) => { button.hidden = true; });
      wasVisibleRef.current = false;
      return;
    }

    wasVisibleRef.current = true;
    const declutter = zoomLevel < 10;
    const candidates: Array<{
      anchorY: number;
      button: HTMLButtonElement;
      layout: ProjectLabelLayout;
      x: number;
    }> = [];

    labelLayouts.forEach((layout) => {
      const button = buttonRefs.current.get(layout.project.id);
      if (!button) return;
      if (layout.project.id === selectedProjectId) {
        button.hidden = true;
        return;
      }
      const projected = projectedPointRef.current.copy(layout.position).project(camera);
      const onScreen = projected.z > -1 && projected.z < 1 && projected.x > -0.99 && projected.x < 0.99 && projected.y > -0.99 && projected.y < 0.99;
      if (!onScreen) {
        button.hidden = true;
        return;
      }

      button.hidden = false;
      candidates.push({
        anchorY: (-projected.y * 0.5 + 0.5) * size.height,
        button,
        layout,
        x: (projected.x * 0.5 + 0.5) * size.width,
      });
    });

    candidates.sort((a, b) => (
      Number(b.layout.groupHasSelected) - Number(a.layout.groupHasSelected)
      || b.layout.groupSize - a.layout.groupSize
      || a.anchorY - b.anchorY
      || a.x - b.x
    ));

    type LabelRect = { bottom: number; left: number; right: number; top: number };
    const placedRects: LabelRect[] = [];
    const firstButton = buttonRefs.current.values().next().value as HTMLButtonElement | undefined;
    const mapRoot = firstButton?.closest(".webgl-map");
    const canvasRect = mapRoot?.querySelector("canvas")?.getBoundingClientRect();
    if (canvasRect && mapRoot) {
      const blockedElements = [...mapRoot.querySelectorAll(".map-callout, .map-help, .map-controls, .map-status, .map-precision-badge, .map-scale-bar")];
      const sidePanel = mapRoot.closest(".workspace")?.querySelector(".side-panel");
      if (sidePanel) blockedElements.push(sidePanel);
      blockedElements.forEach((element) => {
        const blocked = element.getBoundingClientRect();
        if (!blocked.width || !blocked.height) return;
        const padding = size.width < 360 && element.classList.contains("map-controls") ? 0 : 6;
        placedRects.push({
          bottom: blocked.bottom - canvasRect.top + padding,
          left: blocked.left - canvasRect.left - padding,
          right: blocked.right - canvasRect.left + padding,
          top: blocked.top - canvasRect.top - padding,
        });
      });
    }

    const verticalOffsets = [0];
    if (!declutter) {
      for (let distance = 8; distance <= size.height; distance += 8) {
        verticalOffsets.push(-distance, distance);
      }
    }
    const overlaps = (a: LabelRect, b: LabelRect) => (
      a.left < b.right + 4
      && a.right > b.left - 4
      && a.top < b.bottom + 4
      && a.bottom > b.top - 4
    );

    candidates.forEach(({ anchorY, button, layout, x }) => {
      const maxWidth = size.width < 600 ? 170 : 260;
      const hasRoomOnLeft = x >= maxWidth + 18;
      const forceLeft = (layout.groupHasSelected && hasRoomOnLeft) || x > size.width - maxWidth - 18;
      const forceRight = !forceLeft && (layout.groupHasSelected || x < maxWidth + 18);
      const singleColumn = forceLeft || forceRight;
      const preferredSide = forceLeft ? "left" : forceRight ? "right" : layout.groupIndex % 2 === 0 ? "right" : "left";
      const sideChoices = declutter
        ? [preferredSide]
        : [preferredSide, preferredSide === "left" ? "right" : "left"];
      const row = singleColumn ? layout.groupIndex : Math.floor(layout.groupIndex / 2);
      const rows = singleColumn ? layout.groupSize : Math.ceil(layout.groupSize / 2);
      const rowSpacing = size.width < 600 ? 31 : 34;
      const stackHalfHeight = ((rows - 1) * rowSpacing) / 2 + 16;
      const centerY = Math.max(16 + stackHalfHeight, Math.min(size.height - 16 - stackHalfHeight, anchorY));
      const baseY = centerY + (row - (rows - 1) / 2) * rowSpacing;
      const measured = button.getBoundingClientRect();
      const width = Math.min(maxWidth, measured.width || 44 + layout.project.company.length * 10);
      const height = measured.height || (layout.project.company.length > 18 ? 40 : 28);
      let placement: { left: number; y: number } | null = null;

      for (const side of sideChoices) {
        for (const offset of verticalOffsets) {
          const y = baseY + offset;
          const left = side === "left" ? x - 11 - width : x + 11;
          const rect = {
            bottom: y + height / 2,
            left,
            right: left + width,
            top: y - height / 2,
          };
          const withinCanvas = rect.left >= 4 && rect.right <= size.width - 4 && rect.top >= 4 && rect.bottom <= size.height - 4;
          if (withinCanvas && !placedRects.some((placed) => overlaps(rect, placed))) {
            placement = { left, y };
            placedRects.push(rect);
            break;
          }
        }
        if (placement) break;
      }

      if (!placement && !declutter) {
        const rightLane = Math.floor(size.width - width - 4);
        const edgeLanesFit = size.width < 600 && width * 2 + 16 <= size.width;
        const fallbackLefts = [...new Set(edgeLanesFit
          ? [4, rightLane]
          : [4, Math.floor((size.width - width) / 2), rightLane]
        )].filter((left) => left >= 4 && left + width <= size.width - 4);
        const fallbackStep = size.width < 600 ? 4 : 8;
        let fallback: { left: number; y: number; rect: LabelRect; score: number } | null = null;
        for (const left of fallbackLefts) {
          for (let y = 4 + height / 2; y <= size.height - 4 - height / 2; y += fallbackStep) {
            const rect = { bottom: y + height / 2, left, right: left + width, top: y - height / 2 };
            if (placedRects.some((placed) => overlaps(rect, placed))) continue;
            const score = Math.abs(y - anchorY) + Math.abs(left + width / 2 - x) * 0.28;
            if (!fallback || score < fallback.score) fallback = { left, y, rect, score };
          }
        }
        if (fallback) {
          placement = { left: fallback.left, y: fallback.y };
          placedRects.push(fallback.rect);
        }
      }

      if (!placement) {
        button.hidden = true;
        return;
      }
      button.style.transform = `translate3d(${placement.left}px, ${placement.y}px, 0) translate(0, -50%)`;
    });
  });

  return null;
});

const ProjectLabelOverlay = memo(function ProjectLabelOverlay({
  projects,
  visible,
  selectedProjectId,
  buttonRefs,
  onSelectProject,
}: {
  projects: ProjectRecord[];
  visible: boolean;
  selectedProjectId: number | null;
  buttonRefs: { current: Map<number, HTMLButtonElement> };
  onSelectProject: (projectId: number) => void;
}) {
  return (
    <div className="project-label-layer" aria-hidden={!visible}>
      {projects.map((project) => (
        <button
          key={project.id}
          ref={(node) => {
            if (node) buttonRefs.current.set(project.id, node);
            else buttonRefs.current.delete(project.id);
          }}
          className={`project-company-label ${selectedProjectId === project.id ? "is-active" : ""}`}
          type="button"
          hidden
          aria-label={`选择公司 ${companyCode(project)} ${project.company}`}
          title={project.company}
          onPointerDown={(event) => event.stopPropagation()}
          onPointerUp={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onSelectProject(project.id);
          }}
        >
          <span>{companyCode(project)}</span>
          <b>{project.company}</b>
        </button>
      ))}
    </div>
  );
});

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
  const calloutRef = useRef<HTMLElement>(null);
  const calloutAnchorRef = useRef(new Vector3());
  const lastCalloutTransformRef = useRef("");
  const position = useMemo(
    () => (project ? projectWorldPoint(project, coordinateMode, mapData, 0.58) : null),
    [coordinateMode, mapData, project],
  );

  useFrame(({ camera, clock, size }) => {
    const overviewDistance = overviewDistanceForAspect(size.width / Math.max(1, size.height));
    const beaconScale = Math.max(0.18, Math.min(1, Math.abs(camera.position.z) / overviewDistance));
    groupRef.current?.scale.setScalar(beaconScale);

    if (position && calloutRef.current) {
      const anchor = calloutAnchorRef.current
        .set(position.x + 0.18 * beaconScale, position.y + 0.18 * beaconScale, position.z)
        .project(camera);
      const x = (anchor.x * 0.5 + 0.5) * size.width;
      const y = (-anchor.y * 0.5 + 0.5) * size.height;
      const width = calloutRef.current.offsetWidth;
      const height = calloutRef.current.offsetHeight;
      const fitsRight = x + width <= size.width - 12;
      const fitsLeft = x - width >= 12;
      const fitsBelow = y + height <= size.height - 12;
      const fitsAbove = y - height >= 12;
      const minLeft = 12;
      const minTop = 12;
      const maxLeft = Math.max(minLeft, size.width - width - 12);
      const maxTop = Math.max(minTop, size.height - height - 12);
      const clampLeft = (value: number) => Math.max(minLeft, Math.min(maxLeft, value));
      const clampTop = (value: number) => Math.max(minTop, Math.min(maxTop, value));
      const preferredLeft = clampLeft(fitsRight ? x : fitsLeft ? x - width - 18 : x - width / 2);
      const preferredTop = clampTop(fitsBelow ? y : fitsAbove ? y - height - 18 : y - height / 2);
      type CalloutRect = { bottom: number; left: number; right: number; top: number };
      const blockedRects: CalloutRect[] = [];
      const mapRoot = calloutRef.current.closest(".webgl-map");
      const canvasRect = mapRoot?.querySelector("canvas")?.getBoundingClientRect();
      if (mapRoot && canvasRect) {
        const blockedElements = [...mapRoot.querySelectorAll(".map-help, .map-controls, .map-status, .map-precision-badge, .map-scale-bar")];
        const sidePanel = mapRoot.closest(".workspace")?.querySelector(".side-panel");
        if (sidePanel) blockedElements.push(sidePanel);
        blockedElements.forEach((element) => {
          const blocked = element.getBoundingClientRect();
          if (!blocked.width || !blocked.height) return;
          blockedRects.push({
            bottom: blocked.bottom - canvasRect.top + 6,
            left: blocked.left - canvasRect.left - 6,
            right: blocked.right - canvasRect.left + 6,
            top: blocked.top - canvasRect.top - 6,
          });
        });
      }
      const leftCandidates = [preferredLeft, clampLeft(x), clampLeft(x - width - 18), clampLeft(x - width / 2), minLeft, maxLeft];
      const topCandidates = [preferredTop, clampTop(y), clampTop(y - height - 18), clampTop(y - height / 2), minTop, maxTop];
      blockedRects.forEach((blocked) => {
        leftCandidates.push(clampLeft(blocked.left - width), clampLeft(blocked.right));
        topCandidates.push(clampTop(blocked.top - height), clampTop(blocked.bottom));
      });
      const overlaps = (a: CalloutRect, b: CalloutRect) => (
        a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
      );
      let placement: { left: number; score: number; top: number } | null = null;
      for (const left of [...new Set(leftCandidates)]) {
        for (const top of [...new Set(topCandidates)]) {
          const rect = { bottom: top + height, left, right: left + width, top };
          if (blockedRects.some((blocked) => overlaps(rect, blocked))) continue;
          const score = Math.abs(left - preferredLeft) * 0.35 + Math.abs(top - preferredTop);
          if (!placement || score < placement.score) placement = { left, score, top };
        }
      }
      const left = placement?.left ?? preferredLeft;
      const top = placement?.top ?? preferredTop;
      const transform = `translate3d(${(left - x).toFixed(1)}px, ${(top - y).toFixed(1)}px, 0)`;
      if (transform !== lastCalloutTransformRef.current) {
        lastCalloutTransformRef.current = transform;
        calloutRef.current.style.transform = transform;
      }
    }

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
        <article
          ref={calloutRef}
          className="map-callout"
          onPointerDown={(event) => event.stopPropagation()}
          onPointerUp={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
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
  onNationalViewChange,
}: {
  selectedProject: ProjectRecord | null;
  selectedProvince: string | null;
  coordinateMode: CoordinateMode;
  mapData: ChinaMapDataset;
  command: ViewCommand;
  reducedMotion: boolean;
  onZoomChange: (zoom: number) => void;
  onNationalViewChange: (isNational: boolean) => void;
}) {
  const controlsRef = useRef<React.ElementRef<typeof MapControls>>(null);
  const { camera, size } = useThree();
  const aspect = size.width / Math.max(1, size.height);
  const resetDistance = overviewDistanceForAspect(aspect);
  const minDistance = resetDistance / MAX_ZOOM;
  const lastZoomRef = useRef(1);
  const lastNationalViewRef = useRef(true);
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
    const yOffset = Math.min(0.3, distance * 0.16);
    const zOffset = Math.sqrt(Math.max(0.01, distance * distance - yOffset * yOffset));
    const toPosition = new Vector3(target.x, target.y - yOffset, target.z + zOffset);
    animationRef.current = {
      progress: 0,
      fromPosition: camera.position.clone(),
      toPosition,
      fromTarget: currentTarget,
      toTarget: target,
    };
  };

  const selectedProjectId = selectedProject?.id ?? null;

  useEffect(() => {
    if (selectedProject) {
      const position = projectWorldPoint(selectedProject, coordinateMode, mapData, 0);
      const controls = controlsRef.current;
      const currentDistance = controls ? camera.position.distanceTo(controls.target) : resetDistance;
      if (position) animateTo(position, Math.min(currentDistance, aspect < 0.75 ? 34 : 21.5));
      return;
    }
    if (selectedProvince) {
      const province = mapData.provinces.find((item) => item.name === selectedProvince);
      if (province) animateTo(mapPointToWorld(province.label.x, province.label.y, mapData), aspect < 0.75 ? 42 : 25.5);
    }
  }, [coordinateMode, mapData, selectedProjectId, selectedProvince]);

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
    if (!animationRef.current) {
      const isNationalView = controls.target.lengthSq() < 0.0025 && Math.abs(zoom - 1) < 0.05;
      if (isNationalView !== lastNationalViewRef.current) {
        lastNationalViewRef.current = isNationalView;
        onNationalViewChange(isNationalView);
      }
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
      onStart={() => {
        animationRef.current = null;
      }}
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
  showCompanyLabels,
  zoomLevel,
  labelButtonRefs,
  onSelectProvince,
  onSelectProject,
  onClearSelection,
  onZoomChange,
  onNationalViewChange,
}: WebGLMapProps & {
  selectedProvince: string | null;
  command: ViewCommand;
  reducedMotion: boolean;
  showCompanyLabels: boolean;
  zoomLevel: number;
  labelButtonRefs: { current: Map<number, HTMLButtonElement> };
  onSelectProvince: (name: string) => void;
  onZoomChange: (zoom: number) => void;
  onNationalViewChange: (isNational: boolean) => void;
}) {
  const night = theme === "night";
  const locatedProjects = useMemo(
    () => projects.map((project) => ({ project, position: projectWorldPoint(project, coordinateMode, mapData) })).filter((item): item is LocatedProject => Boolean(item.position)),
    [coordinateMode, mapData, projects],
  );
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
      <ProjectInstances locatedProjects={locatedProjects} theme={theme} reducedMotion={reducedMotion} onSelectProject={onSelectProject} />
      <ProjectLabels locatedProjects={locatedProjects} visible={showCompanyLabels} zoomLevel={zoomLevel} buttonRefs={labelButtonRefs} selectedProjectId={selectedProject?.id ?? null} />
      <SelectedBeacon project={selectedProject} coordinateMode={coordinateMode} mapData={mapData} theme={theme} reducedMotion={reducedMotion} onClearSelection={onClearSelection} />
      <ProvinceLabels mapData={mapData} selectedProvince={selectedProvince} />
      <CameraRig selectedProject={selectedProject} selectedProvince={selectedProvince} coordinateMode={coordinateMode} mapData={mapData} command={command} reducedMotion={reducedMotion} onZoomChange={onZoomChange} onNationalViewChange={onNationalViewChange} />
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
  const [isNationalView, setIsNationalView] = useState(true);
  const labelButtonRefs = useRef(new Map<number, HTMLButtonElement>());
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const canRenderWebGL = useMemo(webGLAvailable, []);
  const showCompanyLabels = zoomLevel >= COMPANY_LABEL_ZOOM;
  const selectedProjectId = props.selectedProject?.id ?? null;
  const activeProvince = selectedProjectId === null ? selectedProvince : null;

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReducedMotion(media.matches);
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (selectedProjectId !== null) setSelectedProvince(null);
  }, [selectedProjectId]);

  const issueCommand = (type: ViewCommand["type"]) => {
    if (type === "reset") {
      setSelectedProvince(null);
      props.onClearSelection();
    }
    setCommand((current) => ({ id: current.id + 1, type }));
  };

  const handleSelectProject = useCallback((projectId: number) => {
    setSelectedProvince(null);
    props.onSelectProject(projectId);
  }, [props.onSelectProject]);

  const handleSelectProvince = useCallback((name: string) => {
    props.onClearSelection();
    setSelectedProvince((current) => (current === name ? null : name));
  }, [props.onClearSelection]);

  return (
    <div className="webgl-map">
      {canRenderWebGL ? (
        <Canvas
          dpr={[1, 1.65]}
          camera={{ position: [0, -0.4, 38], fov: 30, near: 0.1, far: 200 }}
          gl={{ antialias: true, alpha: false, powerPreference: "high-performance" }}
          fallback={<StaticMapFallback mapData={props.mapData} projects={props.projects} coordinateMode={props.coordinateMode} theme={props.theme} />}
        >
          <Scene
            {...props}
            selectedProvince={activeProvince}
            command={command}
            reducedMotion={reducedMotion}
            showCompanyLabels={showCompanyLabels}
            zoomLevel={zoomLevel}
            labelButtonRefs={labelButtonRefs}
            onZoomChange={setZoomLevel}
            onNationalViewChange={setIsNationalView}
            onSelectProvince={handleSelectProvince}
            onSelectProject={handleSelectProject}
          />
        </Canvas>
      ) : (
        <StaticMapFallback mapData={props.mapData} projects={props.projects} coordinateMode={props.coordinateMode} theme={props.theme} />
      )}

      <ProjectLabelOverlay
        projects={props.projects}
        visible={showCompanyLabels}
        selectedProjectId={selectedProjectId}
        buttonRefs={labelButtonRefs}
        onSelectProject={handleSelectProject}
      />

      <div className="map-precision-badge"><LocateFixed size={14} /> WebGL 高精度矢量图</div>

      <div
        className="map-help"
        onPointerDown={(event) => event.stopPropagation()}
        onPointerUp={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <button type="button" className="map-help-toggle" onClick={() => setShowHelp((current) => !current)} aria-expanded={showHelp}>
          <CircleHelp size={15} /> 地图使用说明
        </button>
        {showHelp && (
          <div className="map-help-body">
            <span><MousePointer2 size={13} />拖拽移动 · 滚轮缩放 · 最高 20×</span>
            <span><i className="legend-dot" />光点为项目，悬停可查看公司</span>
            <span><i className="legend-label" />4× 起显示公司名，10× 后显示视野内全部公司</span>
          </div>
        )}
      </div>

      <div className="map-scale-bar" aria-hidden="true">
        <div><span>0</span><span>250</span><span>500 km</span></div>
        <i />
      </div>

      <div
        className="map-controls"
        aria-label="地图缩放"
        onPointerDown={(event) => event.stopPropagation()}
        onPointerUp={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <button type="button" onClick={() => issueCommand("in")} aria-label="放大地图" title="放大地图（最高 20×）"><Plus size={18} /></button>
        <button type="button" onClick={() => issueCommand("out")} aria-label="缩小地图"><Minus size={18} /></button>
        <button type="button" onClick={() => issueCommand("reset")} aria-label="显示全国"><RotateCcw size={15} /> 全国</button>
      </div>

      <div className="map-status" aria-live="polite"><span /> {activeProvince || (props.selectedProject ? props.selectedProject.displayCityLabel : isNationalView ? "全国" : "自由浏览")} · {zoomLevel.toFixed(1)}×{showCompanyLabels ? " · 公司名称" : ""}</div>
    </div>
  );
}
