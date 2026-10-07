output "cluster_name" {
  value = module.app.cluster_name
}

output "alb_dns_name" {
  value = module.app.alb_dns_name
}

output "app_distribution_domain" {
  value = module.edge.app_distribution_domain
}

output "ecr_repository_urls" {
  value = module.app.ecr_repository_urls
}

output "app_secret_arn" {
  value = module.app.app_secret_arn
}

output "deploy_role_arn" {
  value = module.app.deploy_role_arn
}

output "db_endpoint" {
  value = module.database.endpoint
}

output "db_master_secret_arn" {
  value = module.database.master_secret_arn
}

output "redis_url" {
  value     = module.cache.redis_url
  sensitive = true
}

output "private_subnet_ids" {
  description = "GitHub variable ECS_SUBNETS (comma-joined) for the migrate task"
  value       = module.network.private_subnet_ids
}

output "tasks_security_group_id" {
  description = "GitHub variable ECS_SECURITY_GROUPS for the migrate task"
  value       = module.network.tasks_security_group_id
}

output "alerts_topic_arn" {
  value = module.observability.alerts_topic_arn
}

output "buckets" {
  value = { private = module.storage.private_bucket, public = module.storage.public_bucket }
}
