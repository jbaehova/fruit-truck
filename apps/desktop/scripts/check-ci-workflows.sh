#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_ROOT="$(cd -- "${SCRIPT_DIR}/../../.." && pwd)"
SHELLCHECK_BIN="${1:-shellcheck}"
ACTIONLINT_BIN="${2:-actionlint}"

[[ -x "${SHELLCHECK_BIN}" || "${SHELLCHECK_BIN}" == "shellcheck" ]] || {
  printf 'ShellCheck executable is missing: %s\n' "${SHELLCHECK_BIN}" >&2
  exit 1
}
[[ -x "${ACTIONLINT_BIN}" || "${ACTIONLINT_BIN}" == "actionlint" ]] || {
  printf 'actionlint executable is missing: %s\n' "${ACTIONLINT_BIN}" >&2
  exit 1
}

shell_scripts=()
while IFS= read -r shell_script; do
  shell_scripts+=("${shell_script}")
done < <(find "${REPOSITORY_ROOT}" -path '*/node_modules' -prune -o -path '*/target' -prune -o -type f -name '*.sh' -print | sort)
(( ${#shell_scripts[@]} > 0 )) || {
  printf 'No shell scripts found to lint.\n' >&2
  exit 1
}

"${SHELLCHECK_BIN}" --severity=error "${shell_scripts[@]}"
"${ACTIONLINT_BIN}" -color "${REPOSITORY_ROOT}/.github/workflows"/*.yml
printf 'ShellCheck and actionlint passed for %d shell scripts and all workflows.\n' "${#shell_scripts[@]}"
