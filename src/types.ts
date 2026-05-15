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

export type ViewMode = "map" | "globe";
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

export interface BoundaryDataset {
  metadata: {
    source: string;
    sourceUrl: string;
    provinceLineCount: number;
    cityLineCount: number;
    note: string;
  };
  provinceLines: number[][][];
  cityLines: number[][][];
}
