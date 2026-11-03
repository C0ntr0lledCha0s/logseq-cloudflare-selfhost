output "d1_database_id" {
  sensitive = true
  value     = cloudflare_d1_database.index.id
}

output "assets_bucket" {
  sensitive = true
  value     = cloudflare_r2_bucket.assets.name
}

output "backups_bucket" {
  sensitive = true
  value     = cloudflare_r2_bucket.backups.name
}

output "connector_oauth_kv_id" {
  sensitive = true
  value     = one(cloudflare_workers_kv_namespace.connector_oauth[*].id)
}

output "connector_d1_id" {
  sensitive = true
  value     = one(cloudflare_d1_database.connector[*].id)
}
