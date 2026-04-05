#!/usr/bin/env node

import { resolve } from "path";
import dotenv from "dotenv";

const root = resolve(new URL(".", import.meta.url).pathname, "..");

dotenv.config({ path: resolve(root, ".env.local") });
dotenv.config({ path: resolve(root, ".env") });

await import(resolve(root, "dist-server/server.mjs"));
