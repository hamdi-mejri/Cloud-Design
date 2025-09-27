module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.0"

  name = "pfe-vpc"
  cidr = "10.0.0.0/16"

  azs = ["eu-west-3a", "eu-west-3b", "eu-west-3c"]

  public_subnets  = ["10.0.0.0/24", "10.0.1.0/24", "10.0.2.0/24"]
  private_subnets = ["10.0.10.0/24", "10.0.11.0/24", "10.0.12.0/24"]

  enable_nat_gateway = true
  single_nat_gateway = true

  tags = {
    Project   = "cloud-design-pfe"
    ManagedBy = "terraform"
    Env       = "dev"
  }

  public_subnet_tags = {
    "kubernetes.io/role/elb"        = "1"
    "kubernetes.io/cluster/pfe-eks" = "shared"
  }

  private_subnet_tags = {
    "kubernetes.io/role/internal-elb" = "1"
    "kubernetes.io/cluster/pfe-eks"   = "shared"
  }
}
