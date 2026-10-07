output "private_bucket" {
  value = aws_s3_bucket.this["private"].id
}

output "public_bucket" {
  value = aws_s3_bucket.this["public"].id
}

output "private_bucket_arn" {
  value = aws_s3_bucket.this["private"].arn
}

output "public_bucket_arn" {
  value = aws_s3_bucket.this["public"].arn
}

output "public_bucket_regional_domain" {
  value = aws_s3_bucket.this["public"].bucket_regional_domain_name
}

output "private_kms_key_arn" {
  value = aws_kms_key.private.arn
}
