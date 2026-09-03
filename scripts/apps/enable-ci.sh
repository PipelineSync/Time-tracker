#!/usr/bin/env bash
#
# Activates the release pipelines by copying the workflow definitions from
# ci/workflows/ into .github/workflows/.
#
# They ship parked in ci/workflows/ because the CI bot that maintains this
# repository is not allowed to create files under .github/workflows (GitHub
# requires the "Workflows" repository permission for that). Run this once
# from an account that HAS that permission, then commit + push:
#
#   ./scripts/apps/enable-ci.sh
#   git add .github/workflows && git commit -m "Enable release workflows" && git push
#
# Afterwards: pushing a tag (git tag v1.1.0 && git push origin v1.1.0) builds
# the Android/iOS packages and the Windows/macOS/Linux installers.
#
set -euo pipefail
cd "$(dirname "$0")/../.."

mkdir -p .github/workflows
cp -f ci/workflows/*.yml .github/workflows/

count=$(ls .github/workflows/*.yml 2>/dev/null | wc -l | tr -d ' ')
echo "Copied $count workflow(s) into .github/workflows/:"
ls .github/workflows/*.yml | sed 's/^/  /'
echo
echo "Next:"
echo "  git add .github/workflows"
echo "  git commit -m 'Enable release workflows'"
echo "  git push"
echo
echo "Note: pushing files under .github/workflows requires the 'Workflows'"
echo "permission on the account or GitHub App you push with."
