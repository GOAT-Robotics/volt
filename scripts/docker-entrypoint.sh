#!/bin/sh
# Applies additive schema changes to the SQLite database on start, then runs the server.
set -e
node ./node_modules/prisma/build/index.js db push --skip-generate
exec "$@"
