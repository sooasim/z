variable "name" {
  description = "Name prefix and ECS cluster name, e.g. jetpool-staging (deploy.sh uses <name>-<role> families)"
  type        = string
}

variable "environment" {
  type = string
}

variable "node_env" {
  description = "NODE_ENV for api/worker (staging | production). production enforces non-mock providers."
  type        = string
}

variable "payment_provider" {
  type    = string
  default = "TOSS"
  validation {
    condition     = contains(["TOSS", "MOCK"], var.payment_provider)
    error_message = "payment_provider must be TOSS or MOCK."
  }
}

variable "vpc_id" {
  type = string
}

variable "public_subnet_ids" {
  type = list(string)
}

variable "private_subnet_ids" {
  type = list(string)
}

variable "alb_security_group_id" {
  type = string
}

variable "tasks_security_group_id" {
  type = string
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

variable "origin_verify_secret" {
  type      = string
  sensitive = true
}

variable "private_bucket" {
  type = string
}

variable "public_bucket" {
  type = string
}

variable "private_bucket_arn" {
  type = string
}

variable "public_bucket_arn" {
  type = string
}

variable "private_kms_key_arn" {
  type = string
}

variable "bootstrap_image_tag" {
  description = "Tag used only for the very first apply; deploy.sh swaps in digests afterwards"
  type        = string
  default     = "bootstrap"
}

variable "api_cpu" {
  type    = number
  default = 512
}

variable "api_memory" {
  type    = number
  default = 1024
}

variable "web_cpu" {
  type    = number
  default = 512
}

variable "web_memory" {
  type    = number
  default = 1024
}

variable "api_desired" {
  type    = number
  default = 2
}

variable "api_max" {
  type    = number
  default = 6
}

variable "worker_desired" {
  type    = number
  default = 1
}

variable "web_desired" {
  type    = number
  default = 2
}

variable "web_max" {
  type    = number
  default = 6
}

variable "db_pool_max" {
  description = "Per-task pg pool size; keep (api_max + worker) * pool < RDS max_connections"
  type        = number
  default     = 20
}

variable "log_retention_days" {
  type    = number
  default = 90
}

variable "deletion_protection" {
  type    = bool
  default = true
}

variable "github_repository" {
  description = "owner/repo allowed to assume the deploy role"
  type        = string
}

variable "github_environment" {
  description = "GitHub Environment whose jobs may deploy (staging | production)"
  type        = string
}

variable "create_github_oidc_provider" {
  description = "Create the account-wide GitHub OIDC provider (only once per AWS account)"
  type        = bool
  default     = false
}

variable "tags" {
  type    = map(string)
  default = {}
}
