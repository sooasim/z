# JETPOOL Terraform (AWS ap-northeast-2)

```
modules/
  network        VPC (public / private / isolated data subnets), NAT, S3 endpoint, flow logs, ALB + task SGs
  database       RDS PostgreSQL 16, KMS, TLS-only params, PITR 14–35 d, Multi-AZ/deletion protection (prod)
  cache          ElastiCache Redis 7 (TLS + auth token, Multi-AZ when replicas > 0)
  storage        S3 private (SSE-KMS, presigned uploads) + public (SSE-S3, CloudFront OAC only), TLS-only policies
  edge           CloudFront (web+api → ALB, media → S3 OAC), WAFv2 (managed rules, IP + /v1/auth rate limits,
                 /metrics & /docs blocked), ACM us-east-1, Route53 aliases
  app            ECR (immutable tags, scan on push), ECS Fargate cluster, task defs (api, worker, web, migrate),
                 services (api, api-canary, worker, web), ALB HTTPS + origin-verify header, Secrets Manager,
                 CloudWatch log groups, autoscaling, GitHub OIDC deploy role
  observability  SNS alerts topic, CloudWatch alarms (5xx ratio, p95, unhealthy hosts, RDS, ECS tasks, log errors)
stack/           composition of all modules for one environment
envs/staging     single NAT, single-AZ RDS (14 d PITR), small instances, deletion protection off
envs/prod        3 AZ, NAT per AZ, Multi-AZ RDS (35 d PITR), Redis replica, deletion protection, WAF Bot Control enforced
```

## First-time setup (human, once per AWS account)
1. Create the state bucket + lock table (commands in `envs/*/backend.tf`), then replace `jetpool-tfstate-REPLACE_ME`.
2. Create/delegate the Route53 hosted zone and set `route53_zone_id` in `terraform.tfvars`.
3. Set `github_repository` (owner/repo). `create_github_oidc_provider = true` in exactly one env per account.
4. `cd envs/staging && terraform init && terraform plan -out plan && terraform apply plan`
5. Push a `bootstrap` image tag to both ECR repos (or deploy once via the workflow), then fill secret
   `jetpool/<env>/app` (keys listed in `modules/app/main.tf` `secret_keys`; `DATABASE_URL` uses a least-privilege
   app role you create in the DB, `REDIS_URL` from the `redis_url` output).
6. Copy outputs into GitHub **environment variables**: `AWS_DEPLOY_ROLE_ARN` (`deploy_role_arn`), `ECS_SUBNETS`
   (`ecs_subnets`), `ECS_SECURITY_GROUPS` (`ecs_security_groups`), `STAGING_API_URL`/`PROD_API_URL`,
   `STAGING_WEB_URL`/`PROD_WEB_URL`; repository variable `DEPLOY_TARGET=ecs`.

## Validation
```bash
terraform fmt -recursive -check
cd envs/staging && terraform init -backend=false && terraform validate
```
Commit `.terraform.lock.hcl` after the first real `init` (`terraform providers lock -platform=linux_amd64 -platform=darwin_arm64`).
