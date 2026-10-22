terraform {
  required_version = ">= 1.10"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5"
    }
  }
}

# Authentication: the provider reads CLOUDFLARE_API_TOKEN from the environment.
provider "cloudflare" {}
