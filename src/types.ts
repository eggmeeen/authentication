export interface Coord {
  lng: number;
  lat: number;
}

export interface ProjectRecord {
  id: number;
  region: string;
  sequence: string;
  companyRaw: string;
  company: string;
  addressRaw: string;
  address: string;
  province: string;
  prefecture: string;
  prefectureCommon: string;
  displayCity: string;
  displayCityLabel: string;
  district: string;
  cityCoord: Coord | null;
  addressCoord: Coord | null;
  coordinateLevel: "district" | "prefecture" | "unresolved";
  matchMethod: string;
  matchedAlias: string;
}

export interface CityGroup {
  key: string;
  province: string;
  city: string;
  label: string;
  lng: number;
  lat: number;
  count: number;
  projectIds: number[];
}

export interface ProjectDataset {
  metadata: {
    title: string;
    sourceFile: string;
    sourceTitle: string;
    extractedProjects: number;
    uniquePlaces: number;
    generatedAt: string;
    coordinateSource: string;
    coordinateSourceUrl: string;
    fallbackCoordinateSourceUrl: string;
    coordinateNote: string;
    unresolvedIds: number[];
    matchMethods: Record<string, number>;
    provinceCounts: Record<string, number>;
  };
  projects: ProjectRecord[];
  cities: CityGroup[];
}

export type CoordinateMode = "city" | "address";
export type ThemeMode = "day" | "night";

export interface MapPoint {
  id: string;
  type: "city" | "project";
  label: string;
  sublabel: string;
  count: number;
  lng: number;
  lat: number;
  projectId: number;
  projectIds: number[];
}

export interface ChinaMapProvince {
  code: string;
  name: string;
  fullname: string;
  path: string;
  label: {
    x: number;
    y: number;
  };
  count: number;
  colorIndex: number;
}

export interface ChinaMapPath {
  province: string;
  name: string;
  path: string;
}

export interface ChinaMapCity {
  province: string;
  name: string;
  fullname: string;
  x: number;
  y: number;
}

export interface ChinaMapDataset {
  metadata: {
    source: string;
    sourceUrl: string;
    width: number;
    height: number;
    padding: number;
    projection: {
      type: "mercator";
      minX: number;
      maxX: number;
      minY: number;
      maxY: number;
      scale: number;
      yOffset: number;
    };
    provinceCount: number;
    cityCount: number;
  };
  provinces: ChinaMapProvince[];
  cityPaths: ChinaMapPath[];
  cities: ChinaMapCity[];
}
