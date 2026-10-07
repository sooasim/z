variable "name" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "subnet_ids" {
  type = list(string)
}

variable "allowed_security_group_ids" {
  type = list(string)
}

variable "node_type" {
  type    = string
  default = "cache.t4g.small"
}

variable "replicas" {
  description = "Read replicas (0 = single node; >0 enables Multi-AZ automatic failover)"
  type        = number
  default     = 0
}

variable "tags" {
  type    = map(string)
  default = {}
}
