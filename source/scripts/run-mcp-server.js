#!/usr/bin/env node
'use strict';

const { createGlasslineMcpServer } = require('../src/mcp/glassline-mcp-server');

const server = createGlasslineMcpServer();
server.startStdio(process.stdin, process.stdout);

process.stdin.resume();
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
