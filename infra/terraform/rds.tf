#############################
# RDS pour INVENTORY
#############################

# 1) Subnet group (subnets privés de ton VPC)
resource "aws_db_subnet_group" "inventory" {
  name       = "pfe-inventory-subnets"
  subnet_ids = module.vpc.private_subnets
  tags = {
    Name      = "pfe-inventory-subnets"
    Project   = "cloud-design-pfe"
    ManagedBy = "terraform"
    Env       = "dev"
  }
}

# 2) SG RDS : n'autorise que les nœuds EKS en 5432
resource "aws_security_group" "rds_inventory" {
  name        = "pfe-rds-inventory-sg"
  description = "Allow PostgreSQL from EKS nodes only"
  vpc_id      = module.vpc.vpc_id
  tags = {
    Name      = "pfe-rds-inventory-sg"
    Project   = "cloud-design-pfe"
    ManagedBy = "terraform"
    Env       = "dev"
  }
}

# Ingress 5432 depuis le SG des nœuds EKS
resource "aws_security_group_rule" "rds_inventory_from_nodes" {
  type                     = "ingress"
  security_group_id        = aws_security_group.rds_inventory.id
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  source_security_group_id = module.eks.node_security_group_id
}

# Egress vers Internet (pour MAJ de packages, etc. via NAT)
resource "aws_security_group_rule" "rds_inventory_egress_all" {
  type              = "egress"
  security_group_id = aws_security_group.rds_inventory.id
  from_port         = 0
  to_port           = 0
  protocol          = "-1"
  cidr_blocks       = [module.vpc.vpc_cidr_block]
}

# 3) Instance RDS PostgreSQL
resource "aws_db_instance" "inventory" {
  identifier        = "pfe-inventory-db"
  engine            = "postgres"
  engine_version    = "15.7"        # version stable & récente
  instance_class    = "db.t3.micro" # ou "db.t4g.micro" si tu veux Graviton
  allocated_storage = 20            # GiB
  storage_type      = "gp3"

  db_subnet_group_name   = aws_db_subnet_group.inventory.name
  vpc_security_group_ids = [aws_security_group.rds_inventory.id]

  publicly_accessible = false
  multi_az            = false

  db_name  = "inventory"
  username = "app_user"
  password = "ChangeMe42!" # pour un PFE c’est ok; sinon mets dans SSM
  port     = 5432

  backup_retention_period = 0    # budget: pas de backup automatiques
  skip_final_snapshot     = true # ⚠️ démo : détruit sans snapshot
  deletion_protection     = false

  monitoring_interval        = 0 # pas d’Enhanced Monitoring (budget)
  auto_minor_version_upgrade = true

  tags = {
    Name      = "pfe-inventory-db"
    Project   = "cloud-design-pfe"
    ManagedBy = "terraform"
    Env       = "dev"
  }
}

output "inventory_rds_endpoint" {
  value = aws_db_instance.inventory.address
}
