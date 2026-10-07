# RDS PostgreSQL 16 — transaction source of truth (invariant 1).
# PITR via automated backups (14–35 days), KMS encryption, TLS enforced, Multi-AZ + deletion protection in prod.
# The master password is generated and rotated by RDS in Secrets Manager (manage_master_user_password).
terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 5.60" }
  }
}

resource "aws_kms_key" "db" {
  description             = "${var.name} RDS encryption"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  tags                    = var.tags
}

resource "aws_kms_alias" "db" {
  name          = "alias/${var.name}-rds"
  target_key_id = aws_kms_key.db.key_id
}

resource "aws_db_subnet_group" "this" {
  name       = "${var.name}-pg"
  subnet_ids = var.subnet_ids
  tags       = var.tags
}

resource "aws_security_group" "db" {
  name        = "${var.name}-pg"
  description = "PostgreSQL access from application tasks only"
  vpc_id      = var.vpc_id
  tags        = var.tags
}

resource "aws_vpc_security_group_ingress_rule" "db_from_app" {
  for_each                     = toset(var.allowed_security_group_ids)
  security_group_id            = aws_security_group.db.id
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "app tasks"
}

resource "aws_db_parameter_group" "pg16" {
  name   = "${var.name}-pg16"
  family = "postgres16"
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  parameter {
    name  = "log_min_duration_statement"
    value = "500"
  }
  parameter {
    name  = "log_lock_waits"
    value = "1"
  }
  parameter {
    name  = "idle_in_transaction_session_timeout"
    value = "60000"
  }
  parameter {
    name         = "shared_preload_libraries"
    value        = "pg_stat_statements"
    apply_method = "pending-reboot"
  }
  tags = var.tags
}

resource "aws_db_instance" "this" {
  identifier                          = "${var.name}-pg"
  engine                              = "postgres"
  engine_version                      = var.engine_version
  instance_class                      = var.instance_class
  allocated_storage                   = var.allocated_storage
  max_allocated_storage               = var.max_allocated_storage
  storage_type                        = "gp3"
  storage_encrypted                   = true
  kms_key_id                          = aws_kms_key.db.arn
  db_name                             = "jetpool"
  username                            = "jetpool_admin"
  manage_master_user_password         = true
  multi_az                            = var.multi_az
  db_subnet_group_name                = aws_db_subnet_group.this.name
  vpc_security_group_ids              = [aws_security_group.db.id]
  parameter_group_name                = aws_db_parameter_group.pg16.name
  publicly_accessible                 = false
  backup_retention_period             = var.backup_retention_days
  backup_window                       = "17:00-18:00" # 02:00–03:00 KST
  maintenance_window                  = "sun:18:30-sun:19:30"
  copy_tags_to_snapshot               = true
  deletion_protection                 = var.deletion_protection
  skip_final_snapshot                 = !var.deletion_protection
  final_snapshot_identifier           = var.deletion_protection ? "${var.name}-pg-final" : null
  auto_minor_version_upgrade          = true
  performance_insights_enabled        = true
  performance_insights_kms_key_id     = aws_kms_key.db.arn
  monitoring_interval                 = var.enhanced_monitoring ? 60 : 0
  monitoring_role_arn                 = var.enhanced_monitoring ? aws_iam_role.monitoring[0].arn : null
  enabled_cloudwatch_logs_exports     = ["postgresql", "upgrade"]
  iam_database_authentication_enabled = true
  tags                                = var.tags

  lifecycle {
    precondition {
      condition     = var.backup_retention_days >= 14 && var.backup_retention_days <= 35
      error_message = "PITR retention must be 14–35 days (docs/runbooks/db-restore-drill.md)."
    }
  }
}

resource "aws_iam_role" "monitoring" {
  count = var.enhanced_monitoring ? 1 : 0
  name  = "${var.name}-rds-monitoring"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "monitoring.rds.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
  tags = var.tags
}

resource "aws_iam_role_policy_attachment" "monitoring" {
  count      = var.enhanced_monitoring ? 1 : 0
  role       = aws_iam_role.monitoring[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}
