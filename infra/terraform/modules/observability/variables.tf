variable "name" {
  type = string
}

variable "alert_emails" {
  type    = list(string)
  default = []
}

variable "alb_arn_suffix" {
  type = string
}

variable "api_target_group_arn_suffix" {
  type = string
}

variable "web_target_group_arn_suffix" {
  type = string
}

variable "db_instance_id" {
  type = string
}

variable "db_max_connections_alarm" {
  type    = number
  default = 300
}

variable "cluster_name" {
  type = string
}

variable "log_group_names" {
  type = map(string)
}

variable "tags" {
  type    = map(string)
  default = {}
}
