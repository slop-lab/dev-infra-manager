#!/usr/bin/env node
// @ts-check
console.log(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), temporary: process.env.TMPDIR ?? null }));
