// Who made the data this world is built from.
//
// Rich, 2026-09-26: "we may need to display attribution for some types of map data under CC
// license, please check our data sources and make sure we can show a (small) attribution".
//
// Two of the sources REQUIRE it and the rest deserve it:
//
//   OpenStreetMap      ODbL 1.0. Attribution is a licence condition — "© OpenStreetMap
//                      contributors" — and it is what every road, building, lot, walk, sign and
//                      name in this world comes from.
//   Macrostrat         CC-BY 4.0. Also a licence condition. Only shown when a site actually
//                      carries geology, which most do not.
//   Meta / WRI canopy  CC-BY 4.0, used only where lidar does not reach (corridor/canopy.py).
//   Copernicus         GLO-30 DEM and Sentinel-2, for sites outside the United States.
//   USGS / USDA        3DEP lidar, NAIP imagery, LANDFIRE vegetation. Public domain as US
//                      federal works, so not a condition — but a world made of someone's survey
//                      should say whose.
//   NASA / Gaia        The Milky Way itself is a real image of the galaxy (Deep Star Maps 2020,
//                      NASA/Goddard SVS, from Gaia data). Public domain, credited because a
//                      picture of our galaxy should say who made it.
//
// WHAT IT SAYS IS WHAT THE SITE USED. A fixed blob of credits would name sources a given bake
// never touched (and, worse, would quietly stop naming one that was added). Each line is keyed to
// something the manifest actually records, so crofton-triangle credits its Maryland lidar and its
// NAIP, and a European site credits Copernicus instead. The sky is the exception: it is the same
// sky over every site, so its credit is not in the manifest and is always appended.

import type { Manifest } from './site'

export interface Credit {
  /** what to show */
  label: string
  /** the licence, when it is a condition rather than a courtesy */
  licence?: string
  href: string
  /** true when the licence requires this line to be shown */
  required?: boolean
}

/** Every credit this particular bake has earned, in the order they should read. */
export function creditsFor(m: Manifest): Credit[] {
  const out: Credit[] = []
  const anyRoads = (m.spine?.segments?.length ?? 0) > 0 || (m.branches?.length ?? 0) > 0
  if (anyRoads || m.buildings?.length || m.vt?.count || m.landuse?.length) {
    out.push({ label: '© OpenStreetMap contributors', licence: 'ODbL', href: 'https://www.openstreetmap.org/copyright', required: true })
  }
  // `units` is a list on a network bake and a count on an older one; either way, having any at
  // all is what decides whether this site carries geology
  const geoUnits = (m.geology as { units?: unknown } | undefined)?.units
  if (Array.isArray(geoUnits) ? geoUnits.length > 0 : Number(geoUnits) > 0) {
    out.push({ label: 'Geology: Macrostrat', licence: 'CC BY 4.0', href: 'https://macrostrat.org/', required: true })
  }
  const flora = m.flora as { evt?: unknown; canopy?: { source?: string } } | undefined
  if (flora?.canopy?.source && /meta|wri|global/i.test(String(flora.canopy.source))) {
    out.push({ label: 'Canopy: Meta / WRI global canopy height', licence: 'CC BY 4.0', href: 'https://registry.opendata.aws/dataforgood-fb-forests/', required: true })
  }
  const lidar = m.lidar as { dataset?: string } | undefined
  if (lidar?.dataset) {
    const eu = /copernicus|glo-?30|eea/i.test(lidar.dataset)
    out.push(
      eu
        ? { label: 'Elevation: Copernicus GLO-30 (© DLR, © Airbus DS, ESA)', href: 'https://spacedata.copernicus.eu/', required: true }
        : { label: `Elevation: USGS 3DEP (${lidar.dataset.replace(/^TNM:/, '')})`, href: 'https://www.usgs.gov/3d-elevation-program' },
    )
  }
  const naip = m.layers?.naip
  if (naip) {
    const s2 = /sentinel|s2/i.test(String((naip as { source?: string }).source ?? ''))
    out.push(
      s2
        ? { label: 'Imagery: Copernicus Sentinel-2', href: 'https://sentinel.esa.int/', required: true }
        : { label: 'Imagery: USDA NAIP', href: 'https://naip-usdaonline.hub.arcgis.com/' },
    )
  }
  if (flora?.evt) out.push({ label: 'Vegetation: LANDFIRE EVT (USGS/USFS)', href: 'https://landfire.gov/' })
  return out
}

/**
 * The sky belongs to every site, so its credit is not in any manifest. Appended after the site's
 * own, always. Not `required`: NASA's visualisations are public domain, and this line is a
 * courtesy — but it is the courtesy the viewer asked for when the galaxy became a real image.
 */
const SKY_CREDITS: Credit[] = [
  {
    label: 'Milky Way: NASA/Goddard SVS (Ernie Wright) · Gaia DR2: ESA/Gaia/DPAC',
    href: 'https://svs.gsfc.nasa.gov/4851/',
  },
]

/**
 * The small line in the corner, and the panel behind it.
 *
 * Small, because it is a credit and not a banner; always present, because two of these are licence
 * conditions and a credit you have to go looking for is not one. Clicking it opens the full list
 * with the licences and the links.
 */
export class Attribution {
  readonly el: HTMLElement
  private list: HTMLElement
  private credits: Credit[] = []

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div')
    this.el.id = 'attribution'
    const short = document.createElement('button')
    short.className = 'attrib-short'
    short.type = 'button'
    // It was always expandable; nothing SAID so. A caret and aria-expanded make the
    // affordance visible, which is the whole difference between a control and a line of text.
    short.setAttribute('aria-expanded', 'false')
    const caret = document.createElement('span')
    caret.className = 'attrib-caret'
    caret.textContent = '\u203A'
    caret.setAttribute('aria-hidden', 'true')
    const shortLabel = document.createElement('span')
    shortLabel.className = 'attrib-label'
    shortLabel.textContent = '© OpenStreetMap contributors'
    short.append(caret, shortLabel)
    short.title = 'where this world’s data comes from'
    this.list = document.createElement('div')
    this.list.className = 'attrib-list'
    this.list.hidden = true
    short.addEventListener('click', () => {
      const open = this.list.hidden === true
      this.list.hidden = !open
      short.setAttribute('aria-expanded', String(open))
      short.classList.toggle('open', open)
    })
    this.el.append(short, this.list)
    parent.append(this.el)
    this.short = short
  }

  private short: HTMLButtonElement

  set(m: Manifest) {
    this.credits = [...creditsFor(m), ...SKY_CREDITS]
    // the short line names the first credit and counts the rest
    const extra = this.credits.length - 1
    const label = this.short.querySelector('.attrib-label')
    if (label) label.textContent = extra > 0 ? `${this.credits[0].label} + ${extra}` : this.credits[0].label
    this.list.replaceChildren()
    for (const c of this.credits) {
      const row = document.createElement('a')
      row.href = c.href
      row.target = '_blank'
      row.rel = 'noreferrer noopener'
      row.className = 'attrib-row'
      row.textContent = c.licence ? `${c.label} · ${c.licence}` : c.label
      this.list.append(row)
    }
  }

  dispose() {
    this.el.remove()
  }
}
