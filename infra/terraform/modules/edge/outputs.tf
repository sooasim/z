output "app_distribution_id" {
  value = aws_cloudfront_distribution.app.id
}

output "app_distribution_domain" {
  value = aws_cloudfront_distribution.app.domain_name
}

output "media_distribution_arn" {
  value = aws_cloudfront_distribution.media.arn
}

output "media_distribution_id" {
  value = aws_cloudfront_distribution.media.id
}

output "web_acl_arn" {
  value = aws_wafv2_web_acl.this.arn
}
