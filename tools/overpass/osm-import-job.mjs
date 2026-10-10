#!/usr/bin/env node
// Writes tools/overpass/osm-import-job.yaml: the Job the world editor creates for an osm-import,
// rendered from the editor's own code (tools/worldeditor/runs.mjs `osmImportJob`) so the manifest
// an admin reviews cannot drift from the one that runs. A test (runs-osm.test.mjs) fails if it has.
//
//   node tools/overpass/osm-import-job.mjs > tools/overpass/osm-import-job.yaml

import { osmImportJob } from '../worldeditor/runs.mjs'

const HEADER = `# THE JOB AN OSM-IMPORT CREATES, for review. GENERATED from tools/worldeditor/runs.mjs
# (osmImportJob) by tools/overpass/osm-import-job.mjs; a test fails if the two differ.
#
# Example values: adding us/virginia to the \`overpass\` instance, which runs on gh200-1-node-2.
# The editor fills in the instance, the region, the node (read from the instance's pod) and a
# unique name; nothing else varies.
#
# What it does (the script is the chart's ConfigMap, tools/overpass/chart/files/import.sh):
#   1. downloads the region's .pbf and .poly from Geofabrik onto the instance's volume, under
#      /db/regions/<id>/ and nowhere else;
#   2. checks it (osmium reads it; it carries a replication sequence to follow; there is room);
#   3. converts it to an osmChange and stages it;
#   4. waits while the instance's \`regions\` sidecar applies it THROUGH THE DISPATCHER, streaming
#      the sidecar's log, then asks the instance for a sample of the region's own ways (all must
#      come back) and exits 0. The database itself is never written by this pod.
#
# RBAC: none beyond the world editor's existing Role — it creates Jobs, and lists pods (to find the
# instance's node). Mounting a PVC and a ConfigMap in a pod spec needs no grant to the creator.
# Prerequisite: the instance's release has regions.enabled=true (tools/overpass/chart/values.yaml),
# which creates the \`<instance>-regions\` ConfigMap and the sidecar. Without it the Job exits 3 and
# says so.
`

/** The example, with `osmImportJob` injected so a test can pass the one it imported. */
export function exampleJob(build = osmImportJob) {
  return build({
    name: 'osm-import-overpass-us-virginia-example',
    runId: 'osm-import-overpass-us-virginia-20261010120000-abcd',
    upstream: 'overpass',
    region: {
      region: 'us/virginia',
      name: 'Virginia',
      pbf: 'https://download.geofabrik.de/north-america/us/virginia-latest.osm.pbf',
      updates: 'https://download.geofabrik.de/north-america/us/virginia-updates',
    },
    node: 'gh200-1-node-2',
    image: 'wiktorn/overpass-api@sha256:9bb5f4a9b54cd225bf828c04c67e7f4010650ff4d70b72157a9473a9ba02d93c',
  })
}

/** A small YAML writer for plain JSON — enough for a manifest, and no dependency for one file. */
export function renderYaml(v, indent = 0) {
  const pad = ' '.repeat(indent)
  const scalar = (x) => {
    if (x === null) return 'null'
    if (typeof x === 'number' || typeof x === 'boolean') return String(x)
    const s = String(x)
    return /^[A-Za-z0-9_./@:-]+$/.test(s) && !/^(true|false|null|yes|no|on|off|[0-9.]+)$/i.test(s) && !s.includes(': ') ? s : JSON.stringify(s)
  }
  if (Array.isArray(v)) {
    if (!v.length) return '[]\n'
    return v.map((x) => {
      if (x && typeof x === 'object') {
        const body = renderYaml(x, indent + 2)
        return `${pad}- ${body.slice(indent + 2)}`
      }
      return `${pad}- ${scalar(x)}\n`
    }).join('')
  }
  if (v && typeof v === 'object') {
    const keys = Object.keys(v)
    if (!keys.length) return '{}\n'
    return keys.map((k) => {
      const x = v[k]
      if (x && typeof x === 'object' && (Array.isArray(x) ? x.length : Object.keys(x).length)) return `${pad}${k}:\n${renderYaml(x, indent + 2)}`
      if (x && typeof x === 'object') return `${pad}${k}: ${Array.isArray(x) ? '[]' : '{}'}\n`
      return `${pad}${k}: ${scalar(x)}\n`
    }).join('')
  }
  return `${pad}${scalar(v)}\n`
}

export const manifest = (build = osmImportJob) => HEADER + renderYaml(exampleJob(build))

if (import.meta.url === `file://${process.argv[1]}`) process.stdout.write(manifest())
