/// <reference types="vite/client" />

declare module '*.geojson' {
  const data: import('geojson').GeoJsonObject
  export default data
}
