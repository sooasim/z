# CloudWatch alarms -> SNS (pager/Slack via AWS Chatbot or PagerDuty email integration). Application-level
# SLO/business alerts (outbox, payments, holds) live in infra/observability/prometheus/alerts.yml.
terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 5.60" }
  }
}

resource "aws_sns_topic" "alerts" {
  name              = "${var.name}-alerts"
  kms_master_key_id = "alias/aws/sns"
  tags              = var.tags
}

resource "aws_sns_topic_subscription" "email" {
  for_each  = toset(var.alert_emails)
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = each.value
}

locals {
  actions = [aws_sns_topic.alerts.arn]
}

# API 5xx ratio > 1% for 5 minutes (availability SLO 99.9% burn).
resource "aws_cloudwatch_metric_alarm" "api_5xx_ratio" {
  alarm_name          = "${var.name}-api-5xx-ratio"
  alarm_description   = "API 5xx > 1% of requests (runbook: docs/runbooks/incident-response.md)"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions

  metric_query {
    id          = "ratio"
    expression  = "IF(req > 50, 100 * err / req, 0)"
    label       = "5xx %"
    return_data = true
  }
  metric_query {
    id = "err"
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "HTTPCode_Target_5XX_Count"
      period      = 60
      stat        = "Sum"
      dimensions  = { LoadBalancer = var.alb_arn_suffix, TargetGroup = var.api_target_group_arn_suffix }
    }
  }
  metric_query {
    id = "req"
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "RequestCount"
      period      = 60
      stat        = "Sum"
      dimensions  = { LoadBalancer = var.alb_arn_suffix, TargetGroup = var.api_target_group_arn_suffix }
    }
  }
  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "api_p95" {
  alarm_name          = "${var.name}-api-p95-latency"
  alarm_description   = "API p95 target response time > 500 ms (quote/hold SLO)"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  extended_statistic  = "p95"
  dimensions          = { LoadBalancer = var.alb_arn_suffix, TargetGroup = var.api_target_group_arn_suffix }
  period              = 60
  evaluation_periods  = 10
  datapoints_to_alarm = 5
  threshold           = 0.5
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions
  tags                = var.tags
}

resource "aws_cloudwatch_metric_alarm" "unhealthy_targets" {
  for_each            = { api = var.api_target_group_arn_suffix, web = var.web_target_group_arn_suffix }
  alarm_name          = "${var.name}-${each.key}-unhealthy-hosts"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  dimensions          = { LoadBalancer = var.alb_arn_suffix, TargetGroup = each.value }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = local.actions
  ok_actions          = local.actions
  tags                = var.tags
}

resource "aws_cloudwatch_metric_alarm" "rds" {
  for_each = {
    cpu         = { metric = "CPUUtilization", threshold = 80, op = "GreaterThanThreshold", stat = "Average" }
    connections = { metric = "DatabaseConnections", threshold = var.db_max_connections_alarm, op = "GreaterThanThreshold", stat = "Maximum" }
    storage     = { metric = "FreeStorageSpace", threshold = 10 * 1024 * 1024 * 1024, op = "LessThanThreshold", stat = "Minimum" }
    replica_lag = { metric = "ReplicaLag", threshold = 60, op = "GreaterThanThreshold", stat = "Maximum" }
  }
  alarm_name          = "${var.name}-rds-${each.key}"
  namespace           = "AWS/RDS"
  metric_name         = each.value.metric
  dimensions          = { DBInstanceIdentifier = var.db_instance_id }
  statistic           = each.value.stat
  period              = 300
  evaluation_periods  = 2
  threshold           = each.value.threshold
  comparison_operator = each.value.op
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions
  tags                = var.tags
}

resource "aws_cloudwatch_metric_alarm" "ecs_running" {
  for_each            = toset(["api", "worker", "web"])
  alarm_name          = "${var.name}-${each.key}-no-running-tasks"
  alarm_description   = "No running ${each.key} tasks (worker down = outbox/holds/payments sweeps stop)"
  namespace           = "ECS/ContainerInsights"
  metric_name         = "RunningTaskCount"
  dimensions          = { ClusterName = var.cluster_name, ServiceName = each.key }
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions
  tags                = var.tags
}

# Unhandled errors logged by the API error handler ("unhandled error") and worker job failures ("job failed").
resource "aws_cloudwatch_log_metric_filter" "errors" {
  for_each       = { api = "unhandled error", worker = "job failed" }
  name           = "${var.name}-${each.key}-errors"
  log_group_name = var.log_group_names[each.key]
  pattern        = "{ $.msg = \"${each.value}\" }"
  metric_transformation {
    name          = "${each.key}_errors"
    namespace     = "JETPOOL/${var.name}"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "log_errors" {
  for_each            = aws_cloudwatch_log_metric_filter.errors
  alarm_name          = "${var.name}-${each.key}-log-errors"
  namespace           = "JETPOOL/${var.name}"
  metric_name         = each.value.metric_transformation[0].name
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = each.key == "api" ? 20 : 5
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  tags                = var.tags
}
