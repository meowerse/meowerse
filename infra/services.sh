#!/usr/bin/env bash
# Shared service -> source-paths map. Sourced by record-deploy.sh and
# deploy-status.sh so "deployed version" and "current source version" are
# computed the SAME way: the SHA of the last commit touching a service's paths.
# Keep in sync with local.services in infra/cloudflare/deploy.tf.
service_paths() {
  case "$1" in
    api)      echo "workers/api packages/ts-shared" ;;   # deployed api = Cloudflare Worker
    web)      echo "apps/web packages/ts-shared" ;;
    worker)   echo "workers/edge" ;;
    auth)     echo "workers/auth apps/auth-web packages/auth-shared" ;; # one Worker: UI assets + OIDC IdP
    meowsenger)     echo "workers/meowsenger apps/meowsenger-web packages/auth-shared packages/auth-sdk" ;; # one Worker: UI assets + BFF
    *)        return 1 ;;
  esac
}

# Short SHA of the last commit that touched a service's source paths.
service_source_sha() {
  local root="$1" svc="$2"
  git -C "$root" log -1 --format=%h -- $(service_paths "$svc") 2>/dev/null || echo none
}

# "YES" if a service has uncommitted changes in its paths, else "no".
service_dirty() {
  local root="$1" svc="$2"
  git -C "$root" status --porcelain -- $(service_paths "$svc") | grep -q . && echo YES || echo no
}
