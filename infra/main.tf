locals {
  settings = jsondecode(file("${path.module}/../config/settings.json"))
}

resource "cloudflare_d1_database" "index" {
  account_id = var.cloudflare_account_id
  name       = local.settings.d1DatabaseName

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_r2_bucket" "assets" {
  account_id = var.cloudflare_account_id
  name       = local.settings.assetsBucket

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_r2_bucket" "backups" {
  account_id = var.cloudflare_account_id
  name       = local.settings.backupsBucket

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_r2_bucket_lifecycle" "backups" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.backups.name

  rules = [{
    id      = "expire-backups"
    enabled = true
    conditions = {
      prefix = ""
    }
    delete_objects_transition = {
      condition = {
        type    = "Age"
        max_age = local.settings.backupRetentionDays * 86400
      }
    }
  }]
}
