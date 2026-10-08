#!/usr/bin/env node
console.log(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), init: process.env.INIT_CWD, pnpmScript: process.env.npm_lifecycle_event }));
