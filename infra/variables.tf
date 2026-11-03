variable "cloudflare_account_id" {
  type        = string
  description = "Cloudflare account ID that owns the D1 database and R2 buckets."
}

variable "tofu_encryption_passphrase" {
  type        = string
  sensitive   = true
  description = "Passphrase for OpenTofu state and plan encryption (at least 16 characters). Set via TF_VAR_tofu_encryption_passphrase."
}

variable "connector_enabled" {
  type        = bool
  description = "Whether the optional Claude connector's KV namespace and D1 database exist. Set via TF_VAR_connector_enabled from CONNECTOR_ENABLED (a GitHub variable in Actions, .env.local locally)."
}
