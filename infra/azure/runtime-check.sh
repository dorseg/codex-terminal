#!/bin/sh
# Run inside the deployed terminal. Creates only its own scratch files.
set -eu
umask 077
check_dir=$(mktemp -d /workspace/.azure-check-XXXXXX)
trap 'rm -rf "$check_dir"' EXIT HUP INT TERM
test "$(id -u)" = 1000
test -w /home/node/.codex
cd "$check_dir"
printf 'persistent workspace\n' > original
ln -s original linked
test "$(cat linked)" = 'persistent workspace'
printf '#!/bin/sh\nprintf "executable works\\n"\n' > executable.sh
chmod 700 executable.sh
test "$(./executable.sh)" = 'executable works'
git init -q
git -c user.name=AzureCheck -c user.email=azure-check@localhost add original executable.sh linked
git -c user.name=AzureCheck -c user.email=azure-check@localhost commit -qm 'Storage compatibility check'
git status --porcelain | test "$(cat)" = ''
mkdir package
cd package
printf '{"private":true,"dependencies":{"typescript":"5.9.3"}}\n' > package.json
npm install --ignore-scripts --no-audit --no-fund --loglevel=error
printf 'const result: string = "build works"; console.log(result);\n' > index.ts
./node_modules/.bin/tsc index.ts --skipLibCheck
test "$(node index.js)" = 'build works'
codex --version
expected_sqlite_home=${CODEX_EXPECTED_SQLITE_HOME:-/home/node/.codex/sqlite}
grep -Fqx "sqlite_home = \"$expected_sqlite_home\"" /home/node/.codex/config.toml
printf 'Git, symlink, executable, npm, build and Codex configuration checks passed.\n'
