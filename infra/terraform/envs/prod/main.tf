provider "aws" {
  region = var.region
  default_tags {
    tags = { Project = "jetpool", Environment = var.environment }
  }
}

# CloudFront certificates and the CLOUDFRONT-scope WAF must live in us-east-1.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
  default_tags {
    tags = { Project = "jetpool", Environment = var.environment }
  }
}

module "stack" {
  source = "../../stack"
  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  environment                 = var.environment
  region                      = var.region
  node_env                    = var.node_env
  payment_provider            = var.payment_provider
  vpc_cidr                    = var.vpc_cidr
  az_count                    = var.az_count
  single_nat_gateway          = var.single_nat_gateway
  web_domain                  = var.web_domain
  api_domain                  = var.api_domain
  media_domain                = var.media_domain
  route53_zone_id             = var.route53_zone_id
  db_instance_class           = var.db_instance_class
  db_multi_az                 = var.db_multi_az
  db_backup_retention_days    = var.db_backup_retention_days
  redis_node_type             = var.redis_node_type
  redis_replicas              = var.redis_replicas
  api_desired                 = var.api_desired
  api_max                     = var.api_max
  web_desired                 = var.web_desired
  web_max                     = var.web_max
  worker_desired              = var.worker_desired
  log_retention_days          = var.log_retention_days
  deletion_protection         = var.deletion_protection
  waf_rate_limit_per_5min     = var.waf_rate_limit_per_5min
  waf_bot_control_block       = var.waf_bot_control_block
  alert_emails                = var.alert_emails
  github_repository           = var.github_repository
  github_environment          = var.github_environment
  create_github_oidc_provider = var.create_github_oidc_provider
}
