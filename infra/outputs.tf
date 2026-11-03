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
