#!/usr/bin/env node
// @ts-check
console.log(JSON.stringify({ npmCache: process.env.NPM_CONFIG_CACHE ?? null, npmCacheAlias: process.env.npm_config_cache ?? null, opencodeConfig: process.env.OPENCODE_CONFIG_CONTENT ?? null, omoProfile: process.env.OMO_PROFILE ?? null, argv: process.argv.slice(2), cwd: process.cwd(), temporary: process.env.TMPDIR ?? null }));
