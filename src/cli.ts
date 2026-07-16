#!/usr/bin/env node
import { runCli } from "./cli-core.js";

process.exitCode = await runCli(process.argv.slice(2));
