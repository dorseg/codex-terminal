#!/bin/bash

pause() {
  printf '\n%s\nPress Enter to close. ' "$1"
  read -r
}

if ! root=$(git rev-parse --show-toplevel 2>/dev/null); then
  pause 'Open a Git checkout to review changes.'
  exit
fi
cd "$root" || exit

diff_file=$(mktemp) || exit
trap 'rm -f -- "$diff_file"' EXIT

if [[ -n $(git status --porcelain) ]]; then
  {
    if git rev-parse --verify --quiet HEAD >/dev/null; then
      git --no-pager diff HEAD --
    else
      git --no-pager diff --cached --
      git --no-pager diff --
    fi
    while IFS= read -r -d '' path; do
      git --no-pager diff --no-index -- /dev/null "$path"
    done < <(git ls-files --others --exclude-standard -z)
  } > "$diff_file"
else
  base=$(git symbolic-ref --quiet refs/remotes/origin/HEAD || printf '%s' origin/main)
  if fork=$(git merge-base "$base" HEAD 2>/dev/null); then
    git --no-pager diff "$fork" HEAD -- > "$diff_file"
  fi
fi

if [[ -s $diff_file ]]; then
  more "$diff_file"
  pause 'End of diff.'
else
  pause 'No changes to review.'
fi
