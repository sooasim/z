output "endpoint" {
  value = aws_db_instance.this.address
}

output "port" {
  value = aws_db_instance.this.port
}

output "db_instance_id" {
  value = aws_db_instance.this.identifier
}

output "master_secret_arn" {
  description = "Secrets Manager secret holding the RDS-managed master credentials"
  value       = aws_db_instance.this.master_user_secret[0].secret_arn
}

output "security_group_id" {
  value = aws_security_group.db.id
}

output "kms_key_arn" {
  value = aws_kms_key.db.arn
}
