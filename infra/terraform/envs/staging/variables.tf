variable "environment" {
  type = string
}

variable "region" {
  type    = string
  default = "ap-northeast-2"
}

variable "node_env" {
  type = string
}

variable "payment_provider" {
  type = string
}

variable "vpc_cidr" {
  type = string
}

variable "az_count" {
  type = number
}

variable "single_nat_gateway" {
  type = bool
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

variable "db_multi_az" {
  type = bool
}

variable "db_backup_retention_days" {
  type = number
}

variable "redis_node_type" {
  type = string
}

variable "redis_replicas" {
  type = number
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
  type = number
}

variable "log_retention_days" {
  type = number
}

variable "deletion_protection" {
  type = bool
}

variable "waf_rate_limit_per_5min" {
  type = number
}

variable "waf_bot_control_block" {
  type = bool
}

variable "alert_emails" {
  type = list(string)
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
