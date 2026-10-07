variable "environment" {
  description = "staging | prod"
  type        = string
  validation {
    condition     = contains(["staging", "prod"], var.environment)
    error_message = "environment must be staging or prod."
  }
}

variable "region" {
  type    = string
  default = "ap-northeast-2"
}

variable "node_env" {
  type = string
}

variable "payment_provider" {
  type    = string
  default = "TOSS"
}

variable "vpc_cidr" {
  type = string
}

variable "az_count" {
  type    = number
  default = 2
}

variable "single_nat_gateway" {
  type    = bool
  default = false
}

variable "web_domain" {
  type = string
}

variable "api_domain" {
  type = string
}

variable "media_domain" {
  type = string
}

variable "route53_zone_id" {
  type = string
}

variable "db_instance_class" {
  type = string
}

variable "db_allocated_storage" {
  type    = number
  default = 50
}

variable "db_multi_az" {
  type = bool
}

variable "db_backup_retention_days" {
  type = number
}

variable "redis_node_type" {
  type    = string
  default = "cache.t4g.small"
}

variable "redis_replicas" {
  type    = number
  default = 0
}

variable "api_desired" {
  type = number
}

variable "api_max" {
  type = number
}

variable "web_desired" {
  type = number
}

variable "web_max" {
  type = number
}

variable "worker_desired" {
  type    = number
  default = 1
}

variable "log_retention_days" {
  type    = number
  default = 90
}

variable "deletion_protection" {
  type = bool
}

variable "waf_rate_limit_per_5min" {
  type    = number
  default = 3000
}

variable "waf_bot_control_block" {
  type    = bool
  default = false
}

variable "alert_emails" {
  type    = list(string)
  default = []
}

variable "github_repository" {
  type = string
}

variable "github_environment" {
  type = string
}

variable "create_github_oidc_provider" {
  type    = bool
  default = false
}

variable "tags" {
  type    = map(string)
  default = {}
}
