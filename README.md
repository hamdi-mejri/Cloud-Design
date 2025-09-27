# Cloud Design Platform – End-to-End Infrastructure & Platform Guide

Ce document résume l’intégralité du projet, de la création de l’infrastructure AWS jusqu’au déploiement continu des microservices sur EKS, avec les leçons apprises et les erreurs fréquentes.

---

## 1. Vue d’ensemble

```mermaid
diagram TD
  A[Terraform backend
  S3 + DynamoDB] --> B[VPC
  CIDR 10.0.0.0/16]
  B --> C[EKS
  nodegroup t3.small]
  B --> D[RDS PostgreSQL
  inventory-db]
  B --> E[RabbitMQ (Helm)]
  C --> F[ECR images
  inventory|billing|api-gateway]
  C --> G[K8s namespace apps]
  G --> H[Deployments + Services
  + HPA]
  H --> I[Ingress ALB + Cognito]
  C --> J[Stack Monitoring
  Prometheus/Grafana]
  J --> K[metrics-server]
  G --> L[Secrets gérés via GitHub Actions]
  G --> M[CI/CD GitHub
  build.yml & deploy.yml]
```

- **Terraform** : modules `vpc`, `eks`, `rds` + backend distant (`infra/terraform`).
- **Conteneurs** : images Node.js (inventory, billing, api-gateway) poussées sur ECR.
- **Kubernetes** : namespace `apps`, services, HPA, NetworkPolicies, Ingress ALB protégé par Cognito.
- **Support** : RabbitMQ (Bitnami), Prometheus/Grafana, metrics-server.
- **Sécurité** : réseaux privés, SG restreints, secrets injectés via CI/CD, TODO TLS/ACM.

---

## 2. Pré-requis

| Élément | Détails |
| --- | --- |
| CLI | `aws`, `kubectl`, `helm`, `terraform`, `docker`, `jq` |
| Terraform | version >= 1.6 (cf. `infra/terraform/versions.tf`) |
| AWS | compte avec droits IAM, SSO (profil `tf-dev`/`cloud-design`), région `eu-west-3` |
| GitHub | dépôt avec OIDC + secrets (voir section CI) |
| Node | `node:20-alpine` utilisé pour les images |

**Variables d’environnement courantes**

```bash
export AWS_PROFILE=tf-dev          # ou cloud-design
export AWS_REGION=eu-west-3
export ACCOUNT_ID=917394547509
```

---

## 3. Backend Terraform (S3 + DynamoDB)

1. Créer le bucket S3 (versioning activé) et la table DynamoDB (clé `LockID`).
2. Configurer `infra/terraform/backend.hcl` :

```hcl
bucket         = "cloud-design-tf-state"
dynamodb_table = "cloud-design-tf-lock"
region         = "eu-west-3"
profile        = "tf-dev"
```

3. Initialiser :

```bash
cd infra/terraform
terraform init -backend-config=backend.hcl
```

> **Erreur fréquente** : `Unable to locate credentials` → lancer `aws configure sso` ou exporter un nouveau token STS.

---

## 4. Provisionnement VPC + EKS + RDS

### 4.1 Réseau & VPC

- Module `terraform-aws-modules/vpc` (`infra/terraform/vpc.tf`).
- CIDR privé `10.0.0.0/16`, 3 AZ, NAT unique (budget).
- Tags `kubernetes.io/role/(elb|internal-elb)` appliqués automatiquement.

### 4.2 Cluster EKS

- Module `terraform-aws-modules/eks` (`infra/terraform/eks.tf`).
- Version Kubernetes `1.30`.
- Node group géré `t3.small`, min=1/max=2.
- `enable_irsa = true` (pour ALB controller + autres services).

### 4.3 Bases de données RDS

- `aws_db_instance.inventory` : `postgres 15.7`, `db.t3.micro`, SG restreint (ingress depuis SG des nœuds, egress limité au VPC `infra/terraform/rds.tf:41-48`).
- DB `billing` réutilise l’instance inventaire (même endpoint, mêmes credentials) → prévoir une instance dédiée si nécessaire.

### 4.4 Exécution

```bash
terraform plan -out plan.out
terraform apply plan.out
```

**Pièges**

| Symptôme | Cause | Résolution |
| --- | --- | --- |
| `ExpiredToken` durant plan/apply | session SSO trop courte | relancer `aws sso login --profile tf-dev --no-browser` (via code) |
| `Error creating NAT Gateway` | quotas AWS | vérifier quotas régionaux, sinon déployer avec `single_nat_gateway = true` |
| `db instance already exists` | nom identique | changer `identifier` ou supprimer instance obsolète |

---

## 5. Images Docker & ECR

### 5.1 Construction locale

```bash
cd services/inventory-app
VERSION=$(git rev-parse --short HEAD)
docker build -t inventory:${VERSION} .
```

> **Erreur** : `npm ci` sans `package-lock.json` → lancer `npm install --package-lock-only` avant la build ou remplacer par `npm install --omit=dev` dans le Dockerfile.

### 5.2 Connexion ECR

```bash
aws ecr get-login-password --region $AWS_REGION \
  | docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
```

Si le compte utilise l’auth SSO : exporter les variables temporaires `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` avant la commande.

### 5.3 Push des images

```bash
for svc in inventory billing api-gateway; do
  docker tag $svc:${VERSION} \
    ${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/$svc:${VERSION}
  docker push ${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/$svc:${VERSION}
  docker tag ${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/$svc:${VERSION} \
    ${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/$svc:latest
  docker push ${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/$svc:latest
done
```

---

## 6. Déploiement Kubernetes

### 6.1 Namespace & ServiceAccounts

- Namespace `apps` (`k8s/apps/inventory/namespace.yaml`).
- Service accounts spécifiques par service (nécessaires pour RBAC/IRSA). 

### 6.2 ConfigMaps & Secrets

- ConfigMaps : routes internes (`inventory` ↔ `billing` ↔ `api-gateway`).
- Secrets *non versionnés* : GitHub Actions les recrée à chaque déploiement.
  - `inventory-db`, `billing-db`, `api-gateway-auth`.

### 6.3 Deployments & Services

- Services de type `ClusterIP`.
- Probes HTTP (`/health`).
- Requests/limits CPU & RAM ajustés.
- Inventaire : image locale `inventory:v2` (penser à remplacer par ECR `inventory:latest`).
- API Gateway & Billing déjà alignés sur ECR.

### 6.4 NetworkPolicies

- Restriction `Ingress` : seulement depuis le namespace `apps` ou VPC ALB.
- TODO éventuel : egress restrictif.

### 6.5 Commandes clés

```bash
kubectl apply -f k8s/apps/inventory/
kubectl apply -f k8s/apps/billing/
kubectl apply -f k8s/apps/api-gateway/
```

> **Erreur** : `the server doesn't have a resource type "..."` → vérifier la version `kubectl`, recharger le contexte `aws eks update-kubeconfig`.

### 6.6 Ingress ALB + Cognito

- Ingress `alb` (annotations : target-type `ip`, schema `internet-facing`, auth Cognito).
- TODO `HTTPS` via ACM inscrit en commentaire (`k8s/apps/api-gateway/ingress.yaml:10`).
- Pensez à créer l’ARN du certificat et à modifier `alb.ingress.kubernetes.io/listen-ports` pour basculer en TLS.

---

## 7. RabbitMQ (Infra namespace)

1. Ajouter le dépôt Helm (si besoin) :

```bash
helm repo add bitnami https://charts.bitnami.com/bitnami
helm repo update
```

2. Installer / mettre à jour :

```bash
helm upgrade --install rabbitmq bitnami/rabbitmq \
  --namespace infra \
  --create-namespace \
  -f k8s/infra/rabbitmq/values.yaml
```

3. Vérifier :

```bash
helm ls -n infra
kubectl get pods -n infra
kubectl logs -n infra rabbitmq-0
```

> **Erreur** : `Chart.yaml file is missing` → on ne déploie pas un chart local, utiliser le chart officiel en lui passant notre fichier `values.yaml`.

---

## 8. Monitoring & Metrics

### 8.1 Stack Prometheus / Grafana

- Installée via manifest standard (namespace `monitoring`).
- Services disponibles en `kubectl -n monitoring get pods`.
- Accès local :
  ```bash
  kubectl -n monitoring port-forward svc/monitoring-grafana 3000:80
  kubectl -n monitoring port-forward svc/monitoring-kube-prometheus-prometheus 9090:9090
  # Grafana login : admin / ChangeMe42!
  ```

### 8.2 metrics-server

- Manifest personnalisé : `k8s/infra/metrics-server/components.yaml`.
- RBAC élargi (`nodes/proxy`, `nodes/metrics`) pour éviter les erreurs 403.
- Redeploiement + suppression du pod pour prendre en compte les règles.
- Vérification :

```bash
kubectl top nodes
kubectl top pods -n apps
```

> **Erreur** : `Metrics API not available` → vérifier les logs `kubectl logs -n kube-system deploy/metrics-server`, ajouter le RBAC manquant, supprimer le pod pour qu’il redémarre.

---

## 9. Autoscaling & Tests de charge

- HPAs définis pour inventory, billing, api-gateway (`autoscaling/v2`, min=1 max=5, CPU 70%).
- Après rectification metrics, lancer un job de charge :

```bash
kubectl create job -n apps loadtest --image=ghcr.io/tsenart/vegeta \
  --attack "vegeta attack -duration=60s -rate=20 \
             -targets=<(echo GET http://<ALB>/inventory/items)"
```

- Monitorer `kubectl get hpa -n apps` et Grafana (dashboard `Kubernetes / Compute Resources`).

> **Erreur** : `unknown` dans les métriques HPA → metrics-server absent ou pod non prêt.

---

## 10. Sécurité

| Zone | Mesure |
| --- | --- |
| Réseau | Sous-réseaux privés, NAT unique, SG RDS ne laisse passer que l’EKS, ALB public unique + ingress.
| Secrets | Fichiers supprimés du repo, `.gitignore` mis à jour (`k8s/apps/*/secret*.yaml`). Secrets créés à la volée par CI.
| IAM | ALB controller via IRSA (`k8s/infra/aws-load-balancer-controller-trust.json`) + rôle assumé depuis GitHub OIDC.
| TLS | TODO : provisionner ACM + domaine et basculer l’Ingress en HTTPS.

---

## 11. CI/CD GitHub Actions

### 11.1 Secrets repos nécessaires

```
INVENTORY_DB_HOST / NAME / USER / PASSWORD
BILLING_DB_HOST / NAME / USER / PASSWORD
COGNITO_USER_POOL_ID / APP_CLIENT_ID / USER_POOL_DOMAIN / REGION
```

### 11.2 Workflow `build.yml`

- Build des images, push sur ECR (tag SHA + latest).
- Lancer manuellement depuis l’onglet Actions si nécessaire.

### 11.3 Workflow `deploy.yml`

- `env` récupère les secrets GitHub.
- Étapes : checkout → config AWS OIDC → kubeconfig → création namespace → création des secrets → application manifests → set image → rollout status.
- Extrait clé (`.github/workflows/deploy.yml:11-88`).

> **Erreur** : `Missing required secret: X` → ajouter la clé dans Settings > Secrets, relancer.

> **Erreur** : `Unable to locate credentials` → s’assurer que le rôle IAM GitHub (OIDC) existe et que `AWS_ROLE_TO_ASSUME` est bien défini.

---

## 12. Troubleshooting & FAQ

| Scénario | Diagnostic | Solution |
| --- | --- | --- |
| `Error loading SSO Token` | token expiré | `aws sso login --profile tf-dev --no-browser` et ouvrir l’URL manuellement |
| `helm upgrade` échoue par absence de chart | chart local incomplet | utiliser `bitnami/rabbitmq` + `-f values.yaml` |
| `kubectl top` renvoie des erreurs 403 | RBAC metrics-server incomplet | Ajouter `nodes/proxy`, `nodes/metrics` et redéployer |
| `docker build` échoue sur `npm ci` | pas de package-lock | générer le `package-lock.json` | 
| `kubectl get pods` affiche `CrashLoopBackOff` | secret manquant | relancer workflow deploy (secrets via GitHub) |
| ALB HTTP uniquement | certificat absent | intégrer ACM, modifier l’Ingress (TODO) |

---

## 13. TODO / Améliorations futures

- **TLS & Domaine** : acheter/configurer un domaine, créer un certificat ACM et mettre l’Ingress en HTTPS.
- **Logging centralisé** : intégrer Loki ou Fluent Bit + CloudWatch Logs.
- **Base Billing dédiée** : isoler les schémas et credentials.
- **Tests automatiques** : pipeline CI pour lancer les tests end-to-end/k6.
- **Observabilité** : alerting dans Prometheus + intégration Grafana Cloud/Slack.

---

## 14. Annexes

### 14.1 Vérifications rapides

```bash
# Terraform
terraform fmt
terraform validate
terraform plan

# K8s
kubectl get nodes
kubectl get pods -A
kubectl get ingress -n apps
kubectl get hpa -n apps

# Helm
helm ls -n infra

# Monitoring
kubectl -n monitoring get pods
kubectl -n monitoring port-forward svc/monitoring-grafana 3000:80
```

### 14.2 Rappels sur les exports AWS temporaires

```bash
export AWS_ACCESS_KEY_ID="<fourni par formateur>"
export AWS_SECRET_ACCESS_KEY="<fourni>"
export AWS_SESSION_TOKEN="<fourni>"
```

> **Astuce** : les tokens expiraient ~30 minutes. Toujours re-exporter avant `kubectl` ou `helm`.

### 14.3 Commandes utiles pour le debug

```bash
kubectl describe pod <pod> -n <ns>
kubectl logs <pod> -n <ns>
kubectl exec -it <pod> -n <ns> -- /bin/sh
kubectl auth can-i --as system:serviceaccount:kube-system:metrics-server get nodes/proxy
```

---

## 15. Conclusion

Toute la plateforme – de Terraform à Kubernetes en passant par CI/CD – est désormais reproductible et documentée. Il reste à finaliser le chiffrement TLS via ACM/domaine, et éventuellement séparer la base Billing ou ajouter des tests de charge automatisés. Ce guide doit servir de runbook pour les futurs déploiements et pour la remise en service en cas d’incident.

