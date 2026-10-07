# Remote state: S3 + DynamoDB lock. Bootstrap once per account (see infra/terraform/README.md):
#   aws s3api create-bucket --bucket jetpool-tfstate-<account_id> --region ap-northeast-2 \
#     --create-bucket-configuration LocationConstraint=ap-northeast-2
#   aws s3api put-bucket-versioning --bucket jetpool-tfstate-<account_id> --versioning-configuration Status=Enabled
#   aws dynamodb create-table --table-name jetpool-tflock --attribute-definitions AttributeName=LockID,AttributeType=S \
#     --key-schema AttributeName=LockID,KeyType=HASH --billing-mode PAY_PER_REQUEST --region ap-northeast-2
# Then: terraform init -backend-config="bucket=jetpool-tfstate-<account_id>"
terraform {
  backend "s3" {
    bucket         = "jetpool-tfstate-REPLACE_ME"
    key            = "jetpool/staging/terraform.tfstate"
    region         = "ap-northeast-2"
    dynamodb_table = "jetpool-tflock"
    encrypt        = true
  }
}
