// GENERATED from pyproj (EPSG:4326 -> EPSG:4978 and EPSG:32618) — see
// tools/corridor/.venv. Regenerate if the ellipsoid definition ever changes; it will not.
export const PYPROJ_ECEF: { lon: number; lat: number; h: number; ecef: [number, number, number] }[] = [
  { lon: -76.683, lat: 39.004, h: 0.0, ecef: [1143180.8777599744, -4829594.354918232, 3992662.1140463403] },
  { lon: -76.683, lat: 39.004, h: 137.5, ecef: [1143205.4897780814, -4829698.333270237, 3992748.6530599645] },
  { lon: -121.9017, lat: 36.3714, h: 12.0, ecef: [-2717188.7806055564, -4365057.63583583, 3761460.8138373476] },
  { lon: -123.9707, lat: 45.9282, h: 250.0, ecef: [-2483298.12443232, -3685705.118313328, 4559879.761926267] },
  { lon: 0.0, lat: 0.0, h: 0.0, ecef: [6378137.0, 0.0, 0.0] },
  { lon: 179.9, lat: -41.2, h: 5.0, ecef: [-4805986.3927435065, 8388.037153084528, -4179164.0088152224] },
  { lon: 12.0, lat: 78.2, h: -30.0, ecef: [1279907.2265663717, 272052.679335562, 6221511.505767557] },
  { lon: -76.0, lat: 39.5, h: 8848.0, ecef: [1193892.593220543, -4788441.649578621, 4040931.539642077] },
]

/** the crofton-triangle bake's own frame: EPSG:32618 with this origin (manifest.frame) */
export const CROFTON_UTM_ANCHOR: [number, number] = [354269.88142914086, 4318567.752850354]

/** points at a UTM offset from that origin, with their true geodetic position */
export const PYPROJ_UTM: { de: number; dn: number; lon: number; lat: number }[] = [
  { de: 0, dn: 0, lon: -76.683, lat: 39.004 },
  { de: 3000, dn: 0, lon: -76.64836727338664, lat: 39.004494574678986 },
  { de: 0, dn: 3000, lon: -76.68364086952764, lat: 39.031022295307835 },
  { de: -4000, dn: 2500, lon: -76.72972425925965, lat: 39.02584263374741 },
  { de: 8000, dn: -6000, lon: -76.5894351597101, lat: 38.951248555836614 },
  { de: 20000, dn: 15000, lon: -76.45487233797851, lat: 39.142228077900874 },
]
