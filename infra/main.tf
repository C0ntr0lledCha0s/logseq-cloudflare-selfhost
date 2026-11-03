locals {
  settings = jsondecode(file("${path.module}/../config/settings.json"))
}

resource "cloudflare_d1_database" "index" {
  account_id = var.cloudflare_account_id
  name       = local.settings.d1DatabaseName
  # Pinned to Cloudflare's default; left unset, the provider plans an update on every apply.
  read_replication = {
    mode = "disabled"
  }

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
    id      = "expire-dated-backups"
    enabled = true
    conditions = {
      prefix = "daily/"
    }
    delete_objects_transition = {
      condition = {
        type    = "Age"
        max_age = local.settings.backupRetentionDays * 86400
      }
    }
  }]
}

# Optional connector (connector.enabled in config/settings.json). enabled=false is only
# guaranteed safe for installs that never enabled it: turning the connector off after it
# was enabled plans a destroy of these two resources, which prevent_destroy refuses (the
# data would be lost), so remove them from state deliberately instead.
resource "cloudflare_workers_kv_namespace" "connector_oauth" {
  count = local.settings.connector.enabled ? 1 : 0

  account_id = var.cloudflare_account_id
  title      = "logseq-connector-oauth"

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_d1_database" "connector" {
  count = local.settings.connector.enabled ? 1 : 0

  account_id = var.cloudflare_account_id
  name       = local.settings.connector.d1DatabaseName
  # Pinned to Cloudflare's default; left unset, the provider plans an update on every apply.
  read_replication = {
    mode = "disabled"
  }

  lifecycle {
    prevent_destroy = true
  }
}
