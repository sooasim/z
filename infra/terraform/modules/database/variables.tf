variable "name" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "subnet_ids" {
  description = "Isolated data subnets"
  type        = list(string)
}

variable "allowed_security_group_ids" {
  description = "Security groups (ECS tasks) allowed to connect on 5432"
  type        = list(string)
}

variable "engine_version" {
  type    = string
  default = "16.4"
}

variable "instance_class" {
  type    = string
  default = "db.t4g.medium"
}

variable "allocated_storage" {
  type    = number
  default = 50
}

variable "max_allocated_storage" {
  type    = number
  default = 500
}

variable "multi_az" {
  type    = bool
  default = false
}

variable "backup_retention_days" {
  description = "Automated backup / PITR window (14–35 days)"
  type        = number
  default     = 14
}

variable "deletion_protection" {
  type    = bool
  default = true
}

variable "enhanced_monitoring" {
  type    = bool
  default = true
}

variable "tags" {
  type    = map(string)
  default = {}
}
