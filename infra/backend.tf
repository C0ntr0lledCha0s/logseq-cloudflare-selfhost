# Partial configuration; supply the rest with: tofu init -backend-config=backend.hcl
# See backend.hcl.example. Credentials come from AWS_ACCESS_KEY_ID /
# AWS_SECRET_ACCESS_KEY, which hold the R2 S3 API keys.
terraform {
  backend "s3" {}
}
