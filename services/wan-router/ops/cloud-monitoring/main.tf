locals {
  service_name = "wan-router"
  log_filter = join("\n", [
    "resource.type=\"cloud_run_revision\"",
    "resource.labels.service_name=\"${local.service_name}\"",
    "jsonPayload.message=\"request_completed\"",
  ])
}

resource "google_logging_metric" "request_failures" {
  name        = "wan_router_request_failures_${var.environment}"
  description = "WAN Router request completions with 5xx status."
  filter      = "${local.log_filter}\njsonPayload.status>=500"
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_logging_metric" "kms_failures" {
  name        = "wan_router_kms_failures_${var.environment}"
  description = "WAN Router KMS operation failures."
  filter      = <<-FILTER
    resource.type="cloud_run_revision"
    resource.labels.service_name="${local.service_name}"
    jsonPayload.message="kms_operation_failed"
    jsonPayload.error_code=("kms_integrity_failed" OR "kms_operation_failed")
  FILTER
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_logging_metric" "audit_failures" {
  name        = "wan_router_audit_failures_${var.environment}"
  description = "WAN Router audit persistence failures."
  filter      = <<-FILTER
    resource.type="cloud_run_revision"
    resource.labels.service_name="${local.service_name}"
    jsonPayload.message="audit_event_failed"
  FILTER
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_monitoring_alert_policy" "request_failures" {
  display_name          = "WAN Router ${var.environment}: request failures"
  combiner              = "OR"
  notification_channels = var.notification_channel_names
  documentation {
    content   = "Owner: wan-router-oncall. Runbook: services/wan-router/docs/OBSERVABILITY-RUNBOOK.md#high-error-rate"
    mime_type = "text/markdown"
  }
  conditions {
    display_name = "5xx request failures"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.request_failures.name}\" resource.type=\"cloud_run_revision\""
      comparison      = "COMPARISON_GT"
      threshold_value = 5
      duration        = "300s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_DELTA"
      }
    }
  }
}

resource "google_monitoring_alert_policy" "kms_failures" {
  display_name          = "WAN Router ${var.environment}: KMS failure"
  combiner              = "OR"
  notification_channels = var.notification_channel_names
  documentation {
    content   = "Owner: wan-router-security. Runbook: services/wan-router/docs/OBSERVABILITY-RUNBOOK.md#kms-failure"
    mime_type = "text/markdown"
  }
  conditions {
    display_name = "KMS operation failed"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.kms_failures.name}\" resource.type=\"cloud_run_revision\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_DELTA"
      }
    }
  }
}

resource "google_monitoring_alert_policy" "audit_failures" {
  display_name          = "WAN Router ${var.environment}: audit pipeline failure"
  combiner              = "OR"
  notification_channels = var.notification_channel_names
  documentation {
    content   = "Owner: wan-router-security. Runbook: services/wan-router/docs/OBSERVABILITY-RUNBOOK.md#audit-pipeline-failure"
    mime_type = "text/markdown"
  }
  conditions {
    display_name = "Audit persistence failed"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.audit_failures.name}\" resource.type=\"cloud_run_revision\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_DELTA"
      }
    }
  }
}

resource "google_monitoring_dashboard" "wan_router" {
  dashboard_json = jsonencode({
    displayName = "WAN Router ${var.environment} Operations"
    mosaicLayout = {
      columns = 12
      tiles = [
        {
          width  = 6
          height = 4
          widget = {
            title = "Cloud Run request latency p95"
            xyChart = {
              dataSets = [{
                plotType = "LINE"
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "metric.type=\"run.googleapis.com/request_latencies\" resource.type=\"cloud_run_revision\" resource.label.\"service_name\"=\"${local.service_name}\""
                    aggregation = {
                      alignmentPeriod  = "60s"
                      perSeriesAligner = "ALIGN_PERCENTILE_95"
                    }
                  }
                }
              }]
            }
          }
        },
        {
          xPos   = 6
          width  = 6
          height = 4
          widget = {
            title = "Cloud Run instance count"
            xyChart = {
              dataSets = [{
                plotType = "LINE"
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "metric.type=\"run.googleapis.com/container/instance_count\" resource.type=\"cloud_run_revision\" resource.label.\"service_name\"=\"${local.service_name}\""
                    aggregation = {
                      alignmentPeriod  = "60s"
                      perSeriesAligner = "ALIGN_MEAN"
                    }
                  }
                }
              }]
            }
          }
        },
        {
          yPos   = 4
          width  = 12
          height = 4
          widget = {
            title = "WAN Router log-based failures"
            xyChart = {
              dataSets = [
                {
                  plotType       = "STACKED_BAR"
                  legendTemplate = "request failures"
                  timeSeriesQuery = {
                    timeSeriesFilter = {
                      filter = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.request_failures.name}\" resource.type=\"cloud_run_revision\""
                      aggregation = {
                        alignmentPeriod  = "60s"
                        perSeriesAligner = "ALIGN_RATE"
                      }
                    }
                  }
                },
                {
                  plotType       = "STACKED_BAR"
                  legendTemplate = "audit failures"
                  timeSeriesQuery = {
                    timeSeriesFilter = {
                      filter = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.audit_failures.name}\" resource.type=\"cloud_run_revision\""
                      aggregation = {
                        alignmentPeriod  = "60s"
                        perSeriesAligner = "ALIGN_RATE"
                      }
                    }
                  }
                }
              ]
            }
          }
        }
      ]
    }
  })
}