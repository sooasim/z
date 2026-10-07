variable "name" {
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

variable "alb_dns_name" {
  type = string
}

variable "origin_verify_secret" {
  description = "Shared secret header CloudFront adds; the ALB rejects requests without it"
  type        = string
  sensitive   = true
}

variable "public_bucket_regional_domain" {
  type = string
}

variable "rate_limit_per_5min" {
  description = "Per-IP request limit over 5 minutes (all paths)"
  type        = number
  default     = 3000
}

variable "auth_rate_limit_per_5min" {
  description = "Per-IP request limit over 5 minutes for /v1/auth/*"
  type        = number
  default     = 100
}

variable "bot_control_block" {
  description = "false = Bot Control in count mode (observe first), true = enforce"
  type        = bool
  default     = false
}

variable "access_log_bucket_domain" {
  description = "Optional S3 bucket domain for CloudFront standard logs"
  type        = string
  default     = ""
}

variable "tags" {
  type    = map(string)
  default = {}
}
