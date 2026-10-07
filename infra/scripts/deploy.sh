#!/usr/bin/env bash
# JETPOOL deployment abstraction. Workflows call this; the hosting target is chosen by DEPLOY_TARGET.
#
#   infra/scripts/deploy.sh <env> [action]
#     env     staging | production
#     action  release (default: migrate + deploy all) | migrate | deploy | canary | promote | rollback | snapshot
#
# Required env:
#   DEPLOY_TARGET   ecs | k8s | fly
#   API_IMAGE       immutable image ref, e.g. ghcr.io/org/jetpool-api@sha256:...   (not for rollback/snapshot)
#   WEB_IMAGE       immutable image ref for the web app                          (not for migrate/rollback/snapshot)
#   STATE_FILE      where `snapshot` writes / `rollback` reads the previous release (default .deploy-state-<env>.json)
# Target-specific env:
#   ecs: AWS credentials (OIDC), AWS_REGION (ap-northeast-2), ECS_CLUSTER (default jetpool-<env>),
#        ECS_SUBNETS, ECS_SECURITY_GROUPS (comma-separated; for the one-shot migrate task)
#   k8s: KUBECONFIG / current context, K8S_NAMESPACE (default jetpool-<env>)
#   fly: FLY_API_TOKEN, FLY_APP_PREFIX (default jetpool-<env>)
#
# Production rules (AGENTS_MASTER invariant 12): this script refuses `production` unless it runs inside the
# GitHub `production` environment job (GITHUB_ENVIRONMENT=production → manual approval) or ALLOW_PROD_DEPLOY=1
# is set explicitly by a human operator. Images must be pinned by digest in production.
# Migrations are forward-only (expand/contract): rollback never runs down-migrations.
set -euo pipefail

ENVIRONMENT="${1:?usage: deploy.sh <staging|production> [action]}"
ACTION="${2:-release}"
TARGET="${DEPLOY_TARGET:?DEPLOY_TARGET must be ecs|k8s|fly}"
STATE_FILE="${STATE_FILE:-.deploy-state-${ENVIRONMENT}.json}"
SERVICES=(api worker web)

log() { printf '[deploy %s/%s/%s] %s\n' "$TARGET" "$ENVIRONMENT" "$ACTION" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing required tool: $1"; }

case "$ENVIRONMENT" in
  staging) ;;
  production)
    if [[ "${GITHUB_ENVIRONMENT:-}" != "production" && "${ALLOW_PROD_DEPLOY:-}" != "1" ]]; then
      die "production deploys only run in the approved GitHub 'production' environment (G10)"
    fi ;;
  *) die "unknown environment '$ENVIRONMENT'" ;;
esac

require_images() {
  for v in "$@"; do
    local ref="${!v:-}"
    [[ -n "$ref" ]] || die "$v is required for '$ACTION'"
    if [[ "$ENVIRONMENT" == "production" && "$ref" != *@sha256:* ]]; then
      die "$v must be pinned by digest in production (got $ref)"
    fi
  done
}
image_for() { [[ "$1" == "web" ]] && echo "${WEB_IMAGE:-}" || echo "${API_IMAGE:-}"; }
command_for() { case "$1" in api) echo api ;; worker) echo worker ;; *) echo "" ;; esac; }

# =====================================================================================  ECS (Fargate)
ECS_CLUSTER="${ECS_CLUSTER:-jetpool-${ENVIRONMENT/production/prod}}"
ecs_family() { echo "${ECS_CLUSTER}-$1"; }

# Register a new task-definition revision of <family> with <image> on its first container. Prints the ARN.
ecs_register() {
  local family="$1" image="$2"
  aws ecs describe-task-definition --task-definition "$family" --query taskDefinition --output json \
    | jq --arg img "$image" '.containerDefinitions[0].image = $img
        | del(.taskDefinitionArn, .revision, .status, .requiresAttributes, .compatibilities, .registeredAt, .registeredBy, .deregisteredAt)' \
    > /tmp/taskdef-"$family".json
  aws ecs register-task-definition --cli-input-json "file:///tmp/taskdef-$family.json" \
    --query taskDefinition.taskDefinitionArn --output text
}

ecs_migrate() {
  require_images API_IMAGE
  local arn task code
  arn="$(ecs_register "$(ecs_family migrate)" "$API_IMAGE")"
  log "running one-shot migrate task $arn"
  task="$(aws ecs run-task --cluster "$ECS_CLUSTER" --launch-type FARGATE --task-definition "$arn" \
    --network-configuration "awsvpcConfiguration={subnets=[${ECS_SUBNETS:?}],securityGroups=[${ECS_SECURITY_GROUPS:?}],assignPublicIp=DISABLED}" \
    --started-by "deploy-${GITHUB_RUN_ID:-manual}" --query 'tasks[0].taskArn' --output text)"
  aws ecs wait tasks-stopped --cluster "$ECS_CLUSTER" --tasks "$task"
  code="$(aws ecs describe-tasks --cluster "$ECS_CLUSTER" --tasks "$task" --query 'tasks[0].containers[0].exitCode' --output text)"
  [[ "$code" == "0" ]] || die "migration task exited with $code (see CloudWatch /jetpool/${ENVIRONMENT}/migrate)"
  log "migrations applied"
}

ecs_update() { # <service> <image> [desired]
  local svc="$1" image="$2" desired="${3:-}" arn
  arn="$(ecs_register "$(ecs_family "$svc")" "$image")"
  log "updating service $svc -> $arn"
  if [[ -n "$desired" ]]; then
    aws ecs update-service --cluster "$ECS_CLUSTER" --service "$svc" --task-definition "$arn" --desired-count "$desired" >/dev/null
  else
    aws ecs update-service --cluster "$ECS_CLUSTER" --service "$svc" --task-definition "$arn" >/dev/null
  fi
}

ecs_wait() { aws ecs wait services-stable --cluster "$ECS_CLUSTER" --services "$@"; }

ecs_snapshot() {
  aws ecs describe-services --cluster "$ECS_CLUSTER" --services "${SERVICES[@]}" \
    --query 'services[].{name:serviceName,taskDefinition:taskDefinition,desired:desiredCount}' --output json \
    | jq '{target:"ecs", services:.}' > "$STATE_FILE"
  log "snapshot written to $STATE_FILE"; cat "$STATE_FILE"
}

ecs_rollback() {
  [[ -f "$STATE_FILE" ]] || die "no snapshot at $STATE_FILE"
  aws ecs update-service --cluster "$ECS_CLUSTER" --service api-canary --desired-count 0 >/dev/null 2>&1 || true
  local names=()
  while read -r name td; do
    log "rolling back $name -> $td"
    aws ecs update-service --cluster "$ECS_CLUSTER" --service "$name" --task-definition "$td" >/dev/null
    names+=("$name")
  done < <(jq -r '.services[] | "\(.name) \(.taskDefinition)"' "$STATE_FILE")
  ecs_wait "${names[@]}"
}

ecs_action() {
  need aws; need jq
  case "$ACTION" in
    snapshot) ecs_snapshot ;;
    migrate)  ecs_migrate ;;
    deploy)   require_images API_IMAGE WEB_IMAGE
              for s in "${SERVICES[@]}"; do ecs_update "$s" "$(image_for "$s")"; done
              ecs_wait "${SERVICES[@]}" ;;
    canary)   # api-canary shares the api target group: 1 task next to N stable tasks gets ~1/(N+1) of traffic
              require_images API_IMAGE
              ecs_update api-canary "$API_IMAGE" 1; ecs_wait api-canary ;;
    promote)  require_images API_IMAGE WEB_IMAGE
              for s in "${SERVICES[@]}"; do ecs_update "$s" "$(image_for "$s")"; done
              ecs_wait "${SERVICES[@]}"
              aws ecs update-service --cluster "$ECS_CLUSTER" --service api-canary --desired-count 0 >/dev/null ;;
    rollback) ecs_rollback ;;
    release)  ACTION=migrate ecs_migrate; ACTION=deploy ecs_action ;;
    *) die "unknown action $ACTION" ;;
  esac
}

# =====================================================================================  Kubernetes
NS="${K8S_NAMESPACE:-jetpool-${ENVIRONMENT/production/prod}}"
k8s_action() {
  need kubectl
  local dir; dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../k8s" && pwd)"
  case "$ACTION" in
    snapshot)
      kubectl -n "$NS" get deploy jetpool-api jetpool-worker jetpool-web -o json \
        | jq '{target:"k8s", deployments:[.items[] | {name:.metadata.name, revision:.metadata.annotations["deployment.kubernetes.io/revision"], image:.spec.template.spec.containers[0].image}]}' > "$STATE_FILE"
      cat "$STATE_FILE" ;;
    migrate)
      require_images API_IMAGE
      kubectl -n "$NS" delete job jetpool-migrate --ignore-not-found --wait=true
      sed "s#IMAGE_PLACEHOLDER#${API_IMAGE}#" "$dir/base/migrate-job.yaml" | kubectl -n "$NS" apply -f -
      kubectl -n "$NS" wait --for=condition=complete job/jetpool-migrate --timeout=600s \
        || { kubectl -n "$NS" logs job/jetpool-migrate --tail=200 || true; die "migration job failed"; } ;;
    deploy|promote)
      require_images API_IMAGE WEB_IMAGE
      kubectl -n "$NS" set image deploy/jetpool-api api="$API_IMAGE"
      kubectl -n "$NS" set image deploy/jetpool-worker worker="$API_IMAGE"
      kubectl -n "$NS" set image deploy/jetpool-web web="$WEB_IMAGE"
      for d in jetpool-api jetpool-worker jetpool-web; do kubectl -n "$NS" rollout status "deploy/$d" --timeout=600s; done
      [[ "$ACTION" == promote ]] && kubectl -n "$NS" scale deploy/jetpool-api-canary --replicas=0 || true ;;
    canary)
      require_images API_IMAGE
      kubectl -n "$NS" set image deploy/jetpool-api-canary api="$API_IMAGE"
      kubectl -n "$NS" scale deploy/jetpool-api-canary --replicas=1
      kubectl -n "$NS" rollout status deploy/jetpool-api-canary --timeout=300s ;;
    rollback)
      kubectl -n "$NS" scale deploy/jetpool-api-canary --replicas=0 || true
      if [[ -f "$STATE_FILE" ]]; then
        while read -r name image; do
          kubectl -n "$NS" set image "deploy/$name" "${name#jetpool-}=$image"
        done < <(jq -r '.deployments[] | "\(.name) \(.image)"' "$STATE_FILE")
      else
        for d in jetpool-api jetpool-worker jetpool-web; do kubectl -n "$NS" rollout undo "deploy/$d"; done
      fi
      for d in jetpool-api jetpool-worker jetpool-web; do kubectl -n "$NS" rollout status "deploy/$d" --timeout=600s; done ;;
    release) ACTION=migrate k8s_action; ACTION=deploy k8s_action ;;
    *) die "unknown action $ACTION" ;;
  esac
}

# =====================================================================================  Fly.io
FLY_PREFIX="${FLY_APP_PREFIX:-jetpool-${ENVIRONMENT/production/prod}}"
fly_action() {
  need flyctl
  local cfg; cfg="$(cd "$(dirname "${BASH_SOURCE[0]}")/../fly" && pwd)"
  case "$ACTION" in
    snapshot)
      { echo '{"target":"fly","apps":['
        local first=1
        for s in "${SERVICES[@]}"; do
          img="$(flyctl image show -a "$FLY_PREFIX-$s" --json | jq -r '.[0] | "\(.Registry)/\(.Repository)@\(.Digest)"')"
          [[ $first -eq 1 ]] || echo ','; first=0
          printf '{"name":"%s","image":"%s"}' "$s" "$img"
        done
        echo ']}'; } > "$STATE_FILE"; cat "$STATE_FILE" ;;
    migrate)
      # fly.api.toml declares release_command = "migrate": it runs once per api deploy before machines roll.
      log "migrations run as the api release_command on Fly (no separate step)" ;;
    deploy|promote)
      require_images API_IMAGE WEB_IMAGE
      flyctl deploy -a "$FLY_PREFIX-api" -c "$cfg/fly.api.toml" --image "$API_IMAGE" --strategy rolling --wait-timeout 600
      flyctl deploy -a "$FLY_PREFIX-worker" -c "$cfg/fly.worker.toml" --image "$API_IMAGE" --strategy rolling
      flyctl deploy -a "$FLY_PREFIX-web" -c "$cfg/fly.web.toml" --image "$WEB_IMAGE" --strategy rolling ;;
    canary)
      require_images API_IMAGE
      flyctl deploy -a "$FLY_PREFIX-api" -c "$cfg/fly.api.toml" --image "$API_IMAGE" --strategy canary --wait-timeout 600 ;;
    rollback)
      [[ -f "$STATE_FILE" ]] || die "no snapshot at $STATE_FILE"
      while read -r name image; do
        flyctl deploy -a "$FLY_PREFIX-$name" -c "$cfg/fly.$name.toml" --image "$image" --strategy immediate
      done < <(jq -r '.apps[] | "\(.name) \(.image)"' "$STATE_FILE") ;;
    release) ACTION=deploy fly_action ;;
    *) die "unknown action $ACTION" ;;
  esac
}

case "$TARGET" in
  ecs) ecs_action ;;
  k8s) k8s_action ;;
  fly) fly_action ;;
  *) die "unsupported DEPLOY_TARGET '$TARGET' (ecs|k8s|fly)" ;;
esac
log "done"
