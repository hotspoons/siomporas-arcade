# deploy — what runs where, written down

Every cluster install is a values file in here plus one command. Nothing is applied with
`helm --set` from somebody's shell, because a flag typed once is a deployment nobody else can
reproduce and nobody can review (Rich, 2026-09-28: "I don't want to run things deployed via click
ops and craft scripts, I want to run them using repeatable deployments").

```
just deploy gh200-1              # everything for that cluster, at the pinned image
just deploy gh200-1 worldeditor  # one release
just deploy gh200-1 --check      # render and diff against what is live; changes nothing
```

## The layout

```
deploy/<cluster>/<release>.yaml    the values, reviewed like code
deploy/<cluster>/cluster.yaml      what is true of the cluster itself, not of a release
```

A release file is the WHOLE input to that install. `helm upgrade --reuse-values` is not used
anywhere: it keeps the values the previous release was installed with, so a chart that gains a
block renders it as nil and the upgrade fails — which happened here on 2026-09-28 — and, worse,
it means the live state depends on the order somebody ran commands in rather than on a file.

## Image tags are pinned, and that is the point

`image.tag` names a build. `latest` would make "what is deployed" a question about when the pod
last restarted, which is the thing this directory exists to stop. `just deploy <cluster> --bump`
rewrites the tags to the newest published image for the current commit and shows the diff; it is
a deliberate edit to a tracked file, not a side effect of deploying.

## What is NOT in here

Secrets. `publish.secretName` names a Secret the cluster already holds; nothing in this directory
contains a credential, and a values file that needed one would be the wrong shape.
