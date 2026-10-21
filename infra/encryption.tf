# State and plan encryption. The passphrase is supplied through
# TF_VAR_tofu_encryption_passphrase (early variable evaluation).
terraform {
  encryption {
    key_provider "pbkdf2" "main" {
      passphrase = var.tofu_encryption_passphrase
    }

    method "aes_gcm" "main" {
      keys = key_provider.pbkdf2.main
    }

    state {
      method   = method.aes_gcm.main
      enforced = true
    }

    plan {
      method   = method.aes_gcm.main
      enforced = true
    }
  }
}
