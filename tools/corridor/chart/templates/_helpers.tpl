{{- define "corridor.name" -}}{{ default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}{{- end -}}
{{- define "corridor.fullname" -}}
{{- if .Values.fullnameOverride }}{{ .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else if contains .Chart.Name .Release.Name }}{{ .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}{{ printf "%s-%s" .Release.Name (include "corridor.name" .) | trunc 63 | trimSuffix "-" }}{{ end -}}
{{- end -}}
{{- define "corridor.labels" -}}
app.kubernetes.io/name: {{ include "corridor.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}
{{- define "corridor.claimName" -}}
{{- if .Values.data.existingClaim }}{{ .Values.data.existingClaim }}{{ else }}{{ include "corridor.fullname" . }}-data{{ end -}}
{{- end -}}
