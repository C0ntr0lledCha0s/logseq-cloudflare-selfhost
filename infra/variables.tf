variable "cloudflare_account_id" {
  type        = string
  description = "Cloudflare account ID that owns the D1 database and R2 buckets."
}

variable "tofu_encryption_passphrase" {
  type        = string
  sensitive   = true
  description = "Passphrase for OpenTofu state and plan encryption (at least 16 characters). Set via TF_VAR_tofu_encryption_passphrase."
}
