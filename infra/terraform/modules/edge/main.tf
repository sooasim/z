# Edge: CloudFront (app + media), WAFv2 (managed rule groups + rate limits), ACM (us-east-1), Route53 aliases.
#  - app distribution: web + api hostnames -> ALB (Host header forwarded, ALB routes by host). Dynamic routes are
#    not cached; /_next/static/* is cached. A secret origin-verify header lets the ALB reject direct traffic.
#  - media distribution: public S3 bucket through Origin Access Control (bucket stays fully private).
terraform {
  required_providers {
    aws = {
      source                = "hashicorp/aws"
      version               = ">= 5.60"
      configuration_aliases = [aws.us_east_1]
    }
  }
}

locals {
  app_aliases = [var.web_domain, var.api_domain]
  # AWS managed policy ids (stable, documented)
  cache_disabled            = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # Managed-CachingDisabled
  cache_optimized           = "658327ea-f89d-4fab-a63d-7e88639e58f6" # Managed-CachingOptimized
  origin_req_all_viewer     = "216adef6-5c7f-47e4-b989-5492eafa07d3" # Managed-AllViewer
  response_security_headers = "67f7725c-6f97-4210-82d7-5512b31e9d03" # Managed-SecurityHeadersPolicy
}

# ---------------------------------------------------------------- certificates (CloudFront requires us-east-1)
resource "aws_acm_certificate" "cf" {
  provider                  = aws.us_east_1
  domain_name               = var.web_domain
  subject_alternative_names = [var.api_domain, var.media_domain]
  validation_method         = "DNS"
  tags                      = var.tags
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "cf_validation" {
  for_each = {
    for o in aws_acm_certificate.cf.domain_validation_options : o.domain_name => {
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

resource "aws_acm_certificate_validation" "cf" {
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.cf.arn
  validation_record_fqdns = [for r in aws_route53_record.cf_validation : r.fqdn]
}

# ---------------------------------------------------------------- WAF (CLOUDFRONT scope lives in us-east-1)
resource "aws_wafv2_web_acl" "this" {
  provider    = aws.us_east_1
  name        = "${var.name}-edge"
  description = "JETPOOL edge protection (PLAT-05)"
  scope       = "CLOUDFRONT"

  default_action {
    allow {}
  }

  # Never expose Prometheus metrics or API docs through the edge.
  rule {
    name     = "block-internal-paths"
    priority = 0
    action {
      block {}
    }
    statement {
      or_statement {
        statement {
          byte_match_statement {
            search_string         = "/metrics"
            positional_constraint = "STARTS_WITH"
            field_to_match {
              uri_path {}
            }
            text_transformation {
              priority = 0
              type     = "LOWERCASE"
            }
          }
        }
        statement {
          byte_match_statement {
            search_string         = "/docs"
            positional_constraint = "STARTS_WITH"
            field_to_match {
              uri_path {}
            }
            text_transformation {
              priority = 0
              type     = "LOWERCASE"
            }
          }
        }
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "block-internal-paths"
      sampled_requests_enabled   = true
    }
  }

  dynamic "rule" {
    for_each = {
      AWSManagedRulesAmazonIpReputationList = 1
      AWSManagedRulesCommonRuleSet          = 2
      AWSManagedRulesKnownBadInputsRuleSet  = 3
      AWSManagedRulesSQLiRuleSet            = 4
      AWSManagedRulesBotControlRuleSet      = 5
    }
    content {
      name     = rule.key
      priority = rule.value
      override_action {
        dynamic "none" {
          for_each = rule.key == "AWSManagedRulesBotControlRuleSet" && !var.bot_control_block ? [] : [1]
          content {}
        }
        dynamic "count" {
          for_each = rule.key == "AWSManagedRulesBotControlRuleSet" && !var.bot_control_block ? [1] : []
          content {}
        }
      }
      statement {
        managed_rule_group_statement {
          vendor_name = "AWS"
          name        = rule.key
          # media uploads go straight to S3 via presigned URLs, but JSON bodies can exceed the 8 KB inspection
          # default; SizeRestrictions_BODY is counted instead of blocked to avoid false positives on listings.
          dynamic "rule_action_override" {
            for_each = rule.key == "AWSManagedRulesCommonRuleSet" ? ["SizeRestrictions_BODY"] : []
            content {
              name = rule_action_override.value
              action_to_use {
                count {}
              }
            }
          }
        }
      }
      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = rule.key
        sampled_requests_enabled   = true
      }
    }
  }

  # Global per-IP rate limit (5-minute window).
  rule {
    name     = "rate-limit-ip"
    priority = 10
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit              = var.rate_limit_per_5min
        aggregate_key_type = "IP"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "rate-limit-ip"
      sampled_requests_enabled   = true
    }
  }

  # Credential-stuffing / OTP brute force: much stricter limit on /v1/auth/*.
  rule {
    name     = "rate-limit-auth"
    priority = 11
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit              = var.auth_rate_limit_per_5min
        aggregate_key_type = "IP"
        scope_down_statement {
          byte_match_statement {
            search_string         = "/v1/auth/"
            positional_constraint = "STARTS_WITH"
            field_to_match {
              uri_path {}
            }
            text_transformation {
              priority = 0
              type     = "LOWERCASE"
            }
          }
        }
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "rate-limit-auth"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.name}-edge"
    sampled_requests_enabled   = true
  }

  tags = var.tags
}

resource "aws_cloudwatch_log_group" "waf" {
  provider          = aws.us_east_1
  name              = "aws-waf-logs-${var.name}" # name prefix required by WAF
  retention_in_days = 90
  tags              = var.tags
}

resource "aws_wafv2_web_acl_logging_configuration" "this" {
  provider                = aws.us_east_1
  resource_arn            = aws_wafv2_web_acl.this.arn
  log_destination_configs = [aws_cloudwatch_log_group.waf.arn]
  redacted_fields {
    single_header {
      name = "authorization"
    }
  }
  redacted_fields {
    single_header {
      name = "cookie"
    }
  }
}

# ---------------------------------------------------------------- app distribution (web + api -> ALB)
resource "aws_cloudfront_distribution" "app" {
  enabled         = true
  is_ipv6_enabled = true
  comment         = "${var.name} web+api"
  aliases         = local.app_aliases
  price_class     = "PriceClass_200" # includes Korea/Japan edge locations
  web_acl_id      = aws_wafv2_web_acl.this.arn
  http_version    = "http2and3"

  origin {
    origin_id   = "alb"
    domain_name = var.alb_dns_name
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
      origin_read_timeout    = 60
    }
    custom_header {
      name  = "x-origin-verify"
      value = var.origin_verify_secret
    }
  }

  default_cache_behavior {
    target_origin_id           = "alb"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = local.cache_disabled
    origin_request_policy_id   = local.origin_req_all_viewer
  }

  ordered_cache_behavior {
    path_pattern             = "/_next/static/*"
    target_origin_id         = "alb"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = true
    cache_policy_id          = local.cache_optimized
    origin_request_policy_id = local.origin_req_all_viewer
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.cf.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  dynamic "logging_config" {
    for_each = var.access_log_bucket_domain != "" ? [1] : []
    content {
      bucket          = var.access_log_bucket_domain
      prefix          = "cloudfront/app/"
      include_cookies = false
    }
  }

  tags = var.tags
}

# ---------------------------------------------------------------- media distribution (public bucket via OAC)
resource "aws_cloudfront_origin_access_control" "media" {
  name                              = "${var.name}-media"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "media" {
  enabled         = true
  is_ipv6_enabled = true
  comment         = "${var.name} media"
  aliases         = [var.media_domain]
  price_class     = "PriceClass_200"
  web_acl_id      = aws_wafv2_web_acl.this.arn
  http_version    = "http2and3"

  origin {
    origin_id                = "public-bucket"
    domain_name              = var.public_bucket_regional_domain
    origin_access_control_id = aws_cloudfront_origin_access_control.media.id
  }

  default_cache_behavior {
    target_origin_id           = "public-bucket"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = local.cache_optimized
    response_headers_policy_id = local.response_security_headers
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.cf.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  tags = var.tags
}

# ---------------------------------------------------------------- DNS
resource "aws_route53_record" "app" {
  for_each = toset(local.app_aliases)
  zone_id  = var.route53_zone_id
  name     = each.value
  type     = "A"
  alias {
    name                   = aws_cloudfront_distribution.app.domain_name
    zone_id                = aws_cloudfront_distribution.app.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "media" {
  zone_id = var.route53_zone_id
  name    = var.media_domain
  type    = "A"
  alias {
    name                   = aws_cloudfront_distribution.media.domain_name
    zone_id                = aws_cloudfront_distribution.media.hosted_zone_id
    evaluate_target_health = false
  }
}
