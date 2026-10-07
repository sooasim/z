# Full JETPOOL environment (composed by envs/staging and envs/prod).
terraform {
  required_providers {
    aws = {
      source                = "hashicorp/aws"
      version               = ">= 5.60"
      configuration_aliases = [aws.us_east_1]
    }
    random = { source = "hashicorp/random", version = ">= 3.5" }
  }
}

data "aws_caller_identity" "current" {}

locals {
  name = "jetpool-${var.environment}"
  tags = merge(var.tags, { Project = "jetpool", Environment = var.environment, ManagedBy = "terraform" })
}

resource "random_password" "origin_verify" {
  length  = 40
  special = false
}

module "network" {
  source             = "../modules/network"
  name               = local.name
  region             = var.region
  cidr               = var.vpc_cidr
  az_count           = var.az_count
  single_nat_gateway = var.single_nat_gateway
  tags               = local.tags
}

module "database" {
  source                     = "../modules/database"
  name                       = local.name
  vpc_id                     = module.network.vpc_id
  subnet_ids                 = module.network.data_subnet_ids
  allowed_security_group_ids = [module.network.tasks_security_group_id]
  instance_class             = var.db_instance_class
  allocated_storage          = var.db_allocated_storage
  multi_az                   = var.db_multi_az
  backup_retention_days      = var.db_backup_retention_days
  deletion_protection        = var.deletion_protection
  tags                       = local.tags
}

module "cache" {
  source                     = "../modules/cache"
  name                       = local.name
  vpc_id                     = module.network.vpc_id
  subnet_ids                 = module.network.data_subnet_ids
  allowed_security_group_ids = [module.network.tasks_security_group_id]
  node_type                  = var.redis_node_type
  replicas                   = var.redis_replicas
  tags                       = local.tags
}

module "storage" {
  source         = "../modules/storage"
  name           = local.name
  bucket_suffix  = data.aws_caller_identity.current.account_id
  upload_origins = ["https://${var.web_domain}"]
  # resolved at apply time; the policy grants read only to the media distribution
  cloudfront_distribution_arn = module.edge.media_distribution_arn
  force_destroy               = !var.deletion_protection
  tags                        = local.tags
}

module "app" {
  source                      = "../modules/app"
  name                        = local.name
  environment                 = var.environment
  node_env                    = var.node_env
  payment_provider            = var.payment_provider
  vpc_id                      = module.network.vpc_id
  public_subnet_ids           = module.network.public_subnet_ids
  private_subnet_ids          = module.network.private_subnet_ids
  alb_security_group_id       = module.network.alb_security_group_id
  tasks_security_group_id     = module.network.tasks_security_group_id
  web_domain                  = var.web_domain
  api_domain                  = var.api_domain
  media_domain                = var.media_domain
  route53_zone_id             = var.route53_zone_id
  origin_verify_secret        = random_password.origin_verify.result
  private_bucket              = module.storage.private_bucket
  public_bucket               = module.storage.public_bucket
  private_bucket_arn          = module.storage.private_bucket_arn
  public_bucket_arn           = module.storage.public_bucket_arn
  private_kms_key_arn         = module.storage.private_kms_key_arn
  api_desired                 = var.api_desired
  api_max                     = var.api_max
  web_desired                 = var.web_desired
  web_max                     = var.web_max
  worker_desired              = var.worker_desired
  log_retention_days          = var.log_retention_days
  deletion_protection         = var.deletion_protection
  github_repository           = var.github_repository
  github_environment          = var.github_environment
  create_github_oidc_provider = var.create_github_oidc_provider
  tags                        = local.tags
}

module "edge" {
  source = "../modules/edge"
  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }
  name                          = local.name
  web_domain                    = var.web_domain
  api_domain                    = var.api_domain
  media_domain                  = var.media_domain
  route53_zone_id               = var.route53_zone_id
  alb_dns_name                  = module.app.alb_dns_name
  origin_verify_secret          = random_password.origin_verify.result
  public_bucket_regional_domain = module.storage.public_bucket_regional_domain
  rate_limit_per_5min           = var.waf_rate_limit_per_5min
  bot_control_block             = var.waf_bot_control_block
  tags                          = local.tags
}

module "observability" {
  source                      = "../modules/observability"
  name                        = local.name
  alert_emails                = var.alert_emails
  alb_arn_suffix              = module.app.alb_arn_suffix
  api_target_group_arn_suffix = module.app.api_target_group_arn_suffix
  web_target_group_arn_suffix = module.app.web_target_group_arn_suffix
  db_instance_id              = module.database.db_instance_id
  cluster_name                = module.app.cluster_name
  log_group_names             = module.app.log_group_names
  tags                        = local.tags
}
