variable "project_id" {
  description = "Google Cloud project containing the WAN Router service."
  type        = string
}

variable "environment" {
  description = "Environment label, normally staging or prod."
  type        = string
  validation {
    condition     = contains(["staging", "prod"], var.environment)
    error_message = "environment must be staging or prod."
  }
}

variable "notification_channel_names" {
  description = "Existing Cloud Monitoring notification channel resource names."
  type        = list(string)
  validation {
    condition     = length(var.notification_channel_names) > 0
    error_message = "At least one tested notification channel is required."
  }
}