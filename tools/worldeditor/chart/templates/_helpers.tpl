{{- define "worldeditor.name" -}}{{ default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}{{- end -}}
{{- define "worldeditor.fullname" -}}
{{- if .Values.fullnameOverride }}{{ .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}{{ printf "%s-%s" .Release.Name (include "worldeditor.name" .) | trunc 63 | trimSuffix "-" }}{{ end -}}
{{- end -}}
{{- define "worldeditor.labels" -}}
app.kubernetes.io/name: {{ include "worldeditor.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}
{{- define "worldeditor.selectorLabels" -}}
app.kubernetes.io/name: {{ include "worldeditor.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
{{/* The data volume. `data.existingClaim` is the POINT: this service and the bake Job share one
     RWX volume, so a bake writes a site and this serves it with nothing copied anywhere. */}}
{{- define "worldeditor.claimName" -}}
{{- .Values.data.existingClaim | default (printf "%s-data" (include "worldeditor.fullname" .)) -}}
{{- end -}}
