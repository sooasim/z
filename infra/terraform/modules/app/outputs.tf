output "cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "alb_dns_name" {
  value = aws_lb.this.dns_name
}

output "alb_arn_suffix" {
  value = aws_lb.this.arn_suffix
}

output "api_target_group_arn_suffix" {
  value = aws_lb_target_group.api.arn_suffix
}

output "web_target_group_arn_suffix" {
  value = aws_lb_target_group.web.arn_suffix
}

output "ecr_repository_urls" {
  value = { for k, r in aws_ecr_repository.this : k => r.repository_url }
}

output "app_secret_arn" {
  value = aws_secretsmanager_secret.app.arn
}

output "deploy_role_arn" {
  description = "Set as GitHub variable AWS_DEPLOY_ROLE_ARN in the matching environment"
  value       = aws_iam_role.deploy.arn
}

output "log_group_names" {
  value = { for k, g in aws_cloudwatch_log_group.app : k => g.name }
}
