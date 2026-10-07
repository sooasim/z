variable "name" {
  description = "Name prefix, e.g. jetpool-staging"
  type        = string
}

variable "region" {
  type = string
}

variable "cidr" {
  type    = string
  default = "10.40.0.0/16"
}

variable "az_count" {
  type    = number
  default = 2
  validation {
    condition     = var.az_count >= 2 && var.az_count <= 4
    error_message = "az_count must be between 2 and 4 (RDS/ALB need at least two AZs)."
  }
}

variable "single_nat_gateway" {
  type    = bool
  default = false
}

variable "flow_logs" {
  type    = bool
  default = true
}

variable "tags" {
  type    = map(string)
  default = {}
}
