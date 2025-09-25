terraform {
  required_version = ">= 1.6"

  backend "s3" {}

  required_providers {
    aws = {
      source = "hashicorp/aws"
      # Contraintes compatibles avec tes modules (EKS/VPC)
      version = ">= 5.0.0, < 6.0.0"
    }
  }
}
