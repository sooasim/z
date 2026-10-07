output "cluster_name" {
  value = module.stack.cluster_name
}

output "app_distribution_domain" {
  value = module.stack.app_distribution_domain
}

output "ecr_repository_urls" {
  value = module.stack.ecr_repository_urls
}

output "app_secret_arn" {
  value = module.stack.app_secret_arn
}

output "deploy_role_arn" {
  value = module.stack.deploy_role_arn
}

output "db_endpoint" {
  value = module.stack.db_endpoint
}

output "db_master_secret_arn" {
  value = module.stack.db_master_secret_arn
}

output "ecs_subnets" {
  value = join(",", module.stack.private_subnet_ids)
}

output "ecs_security_groups" {
  value = module.stack.tasks_security_group_id
}

output "alerts_topic_arn" {
  value = module.stack.alerts_topic_arn
}
