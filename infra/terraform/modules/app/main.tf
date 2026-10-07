# Application tier: ECR, ECS Fargate (api, api-canary, worker, web + one-shot migrate task), ALB (HTTPS/ACM),
# Secrets Manager, CloudWatch log groups, autoscaling and the GitHub OIDC deploy role.
#
# Deployment model: Terraform owns task-definition *shape* (env, secrets, sizing); infra/scripts/deploy.sh
# registers new revisions with an immutable image digest and updates services. Services therefore ignore
# task_definition drift.
terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 5.60" }
  }
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.name
  roles      = ["api", "worker", "web", "migrate"]

  common_env = [
    { name = "NODE_ENV", value = var.node_env },
    { name = "PUBLIC_WEB_URL", value = "https://${var.web_domain}" },
    { name = "PUBLIC_API_URL", value = "https://${var.api_domain}" },
    { name = "CORS_ORIGINS", value = "https://${var.web_domain}" },
    { name = "PAYMENT_PROVIDER", value = var.payment_provider },
    { name = "OAUTH_MOCK", value = "false" },
    { name = "S3_REGION", value = local.region },
    { name = "S3_BUCKET_PRIVATE", value = var.private_bucket },
    { name = "S3_BUCKET_PUBLIC", value = var.public_bucket },
    { name = "CDN_BASE_URL", value = "https://${var.media_domain}" },
    { name = "DATABASE_POOL_MAX", value = tostring(var.db_pool_max) },
    { name = "LOG_LEVEL", value = "info" },
    { name = "JETPOOL_ENV", value = var.environment },
  ]

  # Every key must exist in the app secret JSON (set by an operator, see docs/SECURITY.md §Secrets).
  secret_keys = [
    "DATABASE_URL", "REDIS_URL", "JWT_SECRET", "DATA_ENCRYPTION_KEY",
    "TOSS_SECRET_KEY", "TOSS_CLIENT_KEY", "TOSS_WEBHOOK_SECRET",
    "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "KAKAO_CLIENT_ID", "KAKAO_CLIENT_SECRET",
    "NAVER_CLIENT_ID", "NAVER_CLIENT_SECRET", "MEILI_HOST", "MEILI_API_KEY", "SMTP_URL",
    "ANTHROPIC_API_KEY", "KAKAO_REST_API_KEY",
  ]
  web_secret_keys = []
  secrets         = [for k in local.secret_keys : { name = k, valueFrom = "${aws_secretsmanager_secret.app.arn}:${k}::" }]

  log_config = { for r in local.roles : r => {
    logDriver = "awslogs"
    options = {
      awslogs-group         = aws_cloudwatch_log_group.app[r].name
      awslogs-region        = local.region
      awslogs-stream-prefix = r
    }
  } }
}

# ---------------------------------------------------------------- registry
resource "aws_ecr_repository" "this" {
  for_each             = toset(["api", "web"])
  name                 = "${var.name}-${each.key}"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
  encryption_configuration {
    encryption_type = "KMS"
  }
  tags = var.tags
}

resource "aws_ecr_lifecycle_policy" "this" {
  for_each   = aws_ecr_repository.this
  repository = each.value.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "keep last 50 images (rollback window)"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 50 }
      action       = { type = "expire" }
    }]
  })
}

# ---------------------------------------------------------------- secrets
resource "aws_secretsmanager_secret" "app" {
  name                    = "jetpool/${var.environment}/app"
  description             = "JETPOOL ${var.environment} application secrets (JSON). Values are set by operators, never in git."
  kms_key_id              = aws_kms_key.secrets.arn
  recovery_window_in_days = 30
  tags                    = var.tags
}

resource "aws_secretsmanager_secret_version" "app_placeholder" {
  secret_id     = aws_secretsmanager_secret.app.id
  secret_string = jsonencode({ for k in local.secret_keys : k => "SET_ME" })
  lifecycle {
    ignore_changes = [secret_string] # operators rotate values out-of-band
  }
}

resource "aws_kms_key" "secrets" {
  description             = "${var.name} application secrets"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  tags                    = var.tags
}

# ---------------------------------------------------------------- logs
resource "aws_cloudwatch_log_group" "app" {
  for_each          = toset(local.roles)
  name              = "/jetpool/${var.environment}/${each.key}"
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

# ---------------------------------------------------------------- IAM
data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${var.name}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "execution_secrets" {
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = [aws_secretsmanager_secret.app.arn] },
      { Effect = "Allow", Action = ["kms:Decrypt"], Resource = [aws_kms_key.secrets.arn] },
    ]
  })
}

resource "aws_iam_role" "task" {
  name               = "${var.name}-ecs-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
  tags               = var.tags
}

# Least privilege: object access to the two media buckets only (presign + promotion private -> public).
resource "aws_iam_role_policy" "task_s3" {
  role = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"]
        Resource = ["${var.private_bucket_arn}/*", "${var.public_bucket_arn}/*"]
      },
      { Effect = "Allow", Action = ["s3:ListBucket"], Resource = [var.private_bucket_arn, var.public_bucket_arn] },
      { Effect = "Allow", Action = ["kms:GenerateDataKey", "kms:Decrypt"], Resource = [var.private_kms_key_arn] },
    ]
  })
}

# ---------------------------------------------------------------- cluster
resource "aws_ecs_cluster" "this" {
  name = var.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
  tags = var.tags
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]
  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
}

# ---------------------------------------------------------------- task definitions
resource "aws_ecs_task_definition" "api_like" {
  for_each                 = { api = "api", worker = "worker", migrate = "migrate" }
  family                   = "${var.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = each.key == "api" ? var.api_cpu : 512
  memory                   = each.key == "api" ? var.api_memory : 1024
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
  container_definitions = jsonencode([{
    name                   = each.key
    image                  = "${aws_ecr_repository.this["api"].repository_url}:${var.bootstrap_image_tag}"
    command                = [each.value]
    essential              = true
    readonlyRootFilesystem = false
    user                   = "node"
    portMappings           = each.key == "api" ? [{ containerPort = 4000, protocol = "tcp" }] : []
    environment            = concat(local.common_env, [{ name = "PORT", value = "4000" }])
    secrets                = local.secrets
    logConfiguration       = local.log_config[each.key]
    stopTimeout            = 30
  }])
  tags = var.tags
}

resource "aws_ecs_task_definition" "web" {
  family                   = "${var.name}-web"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.web_cpu
  memory                   = var.web_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
  container_definitions = jsonencode([{
    name         = "web"
    image        = "${aws_ecr_repository.this["web"].repository_url}:${var.bootstrap_image_tag}"
    essential    = true
    user         = "node"
    portMappings = [{ containerPort = 3000, protocol = "tcp" }]
    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "PORT", value = "3000" },
      { name = "API_INTERNAL_URL", value = "https://${var.api_domain}" },
    ]
    logConfiguration = local.log_config["web"]
  }])
  tags = var.tags
}

# ---------------------------------------------------------------- ALB
resource "aws_acm_certificate" "alb" {
  domain_name               = var.web_domain
  subject_alternative_names = [var.api_domain]
  validation_method         = "DNS"
  tags                      = var.tags
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "alb_validation" {
  for_each = {
    for o in aws_acm_certificate.alb.domain_validation_options : o.domain_name => {
      name = o.resource_record_name, type = o.resource_record_type, value = o.resource_record_value
    }
  }
  zone_id         = var.route53_zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.value]
  ttl             = 300
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "alb" {
  certificate_arn         = aws_acm_certificate.alb.arn
  validation_record_fqdns = [for r in aws_route53_record.alb_validation : r.fqdn]
}

resource "aws_lb" "this" {
  name                       = var.name
  load_balancer_type         = "application"
  internal                   = false
  security_groups            = [var.alb_security_group_id]
  subnets                    = var.public_subnet_ids
  drop_invalid_header_fields = true
  enable_deletion_protection = var.deletion_protection
  idle_timeout               = 65
  tags                       = var.tags
}

resource "aws_lb_target_group" "api" {
  name                 = "${var.name}-api"
  port                 = 4000
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = var.vpc_id
  deregistration_delay = 30
  health_check {
    path                = "/health"
    matcher             = "200"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
  tags = var.tags
}

resource "aws_lb_target_group" "web" {
  name                 = "${var.name}-web"
  port                 = 3000
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = var.vpc_id
  deregistration_delay = 30
  health_check {
    path                = "/"
    matcher             = "200-399"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
  tags = var.tags
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.alb.certificate_arn
  # Anything that did not come through CloudFront (missing/wrong x-origin-verify) is rejected.
  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "application/json"
      message_body = "{\"status\":403,\"code\":\"DIRECT_ORIGIN_ACCESS\"}"
      status_code  = "403"
    }
  }
}

resource "aws_lb_listener_rule" "metrics_block" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 5
  action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "not found"
      status_code  = "404"
    }
  }
  condition {
    path_pattern {
      values = ["/metrics", "/metrics/*", "/docs", "/docs/*"]
    }
  }
}

resource "aws_lb_listener_rule" "api" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 10
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
  condition {
    host_header {
      values = [var.api_domain]
    }
  }
  condition {
    http_header {
      http_header_name = "x-origin-verify"
      values           = [var.origin_verify_secret]
    }
  }
}

resource "aws_lb_listener_rule" "web" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 20
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
  condition {
    host_header {
      values = [var.web_domain]
    }
  }
  condition {
    http_header {
      http_header_name = "x-origin-verify"
      values           = [var.origin_verify_secret]
    }
  }
}

# ---------------------------------------------------------------- services
locals {
  services = {
    api        = { td = aws_ecs_task_definition.api_like["api"].arn, desired = var.api_desired, tg = aws_lb_target_group.api.arn, port = 4000, container = "api" }
    api-canary = { td = aws_ecs_task_definition.api_like["api"].arn, desired = 0, tg = aws_lb_target_group.api.arn, port = 4000, container = "api" }
    worker     = { td = aws_ecs_task_definition.api_like["worker"].arn, desired = var.worker_desired, tg = null, port = null, container = "worker" }
    web        = { td = aws_ecs_task_definition.web.arn, desired = var.web_desired, tg = aws_lb_target_group.web.arn, port = 3000, container = "web" }
  }
}

resource "aws_ecs_service" "this" {
  for_each                           = local.services
  name                               = each.key
  cluster                            = aws_ecs_cluster.this.id
  task_definition                    = each.value.td
  desired_count                      = each.value.desired
  launch_type                        = "FARGATE"
  enable_execute_command             = false
  propagate_tags                     = "SERVICE"
  health_check_grace_period_seconds  = each.value.tg == null ? null : 30
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [var.tasks_security_group_id]
    assign_public_ip = false
  }

  dynamic "load_balancer" {
    for_each = each.value.tg == null ? [] : [1]
    content {
      target_group_arn = each.value.tg
      container_name   = each.value.container
      container_port   = each.value.port
    }
  }

  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }

  depends_on = [aws_lb_listener.https]
  tags       = var.tags
}

# ---------------------------------------------------------------- autoscaling (api, web)
resource "aws_appautoscaling_target" "this" {
  for_each           = { api = var.api_max, web = var.web_max }
  service_namespace  = "ecs"
  scalable_dimension = "ecs:service:DesiredCount"
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.this[each.key].name}"
  min_capacity       = each.key == "api" ? var.api_desired : var.web_desired
  max_capacity       = each.value
}

resource "aws_appautoscaling_policy" "cpu" {
  for_each           = aws_appautoscaling_target.this
  name               = "${var.name}-${each.key}-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = each.value.service_namespace
  scalable_dimension = each.value.scalable_dimension
  resource_id        = each.value.resource_id
  target_tracking_scaling_policy_configuration {
    target_value       = 60
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

# ---------------------------------------------------------------- GitHub OIDC deploy role
resource "aws_iam_openid_connect_provider" "github" {
  count           = var.create_github_oidc_provider ? 1 : 0
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
  tags            = var.tags
}

data "aws_iam_openid_connect_provider" "github" {
  count = var.create_github_oidc_provider ? 0 : 1
  url   = "https://token.actions.githubusercontent.com"
}

locals {
  github_oidc_arn = var.create_github_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : data.aws_iam_openid_connect_provider.github[0].arn
}

resource "aws_iam_role" "deploy" {
  name = "${var.name}-github-deploy"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = local.github_oidc_arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = { "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com" }
        # Only jobs running in the matching GitHub Environment can assume this role (prod = approved jobs only).
        StringLike = { "token.actions.githubusercontent.com:sub" = "repo:${var.github_repository}:environment:${var.github_environment}" }
      }
    }]
  })
  tags = var.tags
}

resource "aws_iam_role_policy" "deploy" {
  role = aws_iam_role.deploy.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ecs:DescribeServices", "ecs:UpdateService", "ecs:DescribeTaskDefinition", "ecs:RegisterTaskDefinition",
          "ecs:RunTask", "ecs:DescribeTasks", "ecs:ListTasks",
        ]
        Resource  = "*"
        Condition = { StringEqualsIfExists = { "ecs:cluster" = aws_ecs_cluster.this.arn } }
      },
      {
        Effect   = "Allow"
        Action   = ["iam:PassRole"]
        Resource = [aws_iam_role.execution.arn, aws_iam_role.task.arn]
      },
      {
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["ecr:BatchCheckLayerAvailability", "ecr:PutImage", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:BatchGetImage"]
        Resource = [for r in aws_ecr_repository.this : r.arn]
      },
    ]
  })
}
