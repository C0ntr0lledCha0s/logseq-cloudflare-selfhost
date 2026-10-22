output "d1_database_id" {
  value = cloudflare_d1_database.index.id
}

output "assets_bucket" {
  value = cloudflare_r2_bucket.assets.name
}

output "backups_bucket" {
  value = cloudflare_r2_bucket.backups.name
}
