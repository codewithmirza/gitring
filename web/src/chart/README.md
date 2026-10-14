# chart

The overview map of a project: the repository as islands, with every active agent on it.

- `Chart.tsx`: the `Chart` component (pan, zoom, selection) and the front door for the layers.
- `ChartLegend.tsx`: the legend under the map.
- `layout.ts`: the islands and parcels (files) for a file list.
- `panzoom.ts`: pan and zoom of the map by pointer, wheel and keys.
- `placement.ts`: the place of each vessel on the map.
- `static-layers.tsx`: sea, land, parcels, compass rose and graticule.
- `vessel-layers.tsx`: the vessels, their wakes and their tracks.
- `range-layers.tsx`: contours, distance lines, pulses and change-request buoys.
- `chart.css`: the styles of the map.
