import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import mongoose from "mongoose";
import {
  seedRolePermissionCompatibility,
  validateCompatibilityPermissionMap,
  verifyRolePermissionCompatibility,
} from "../src/services/rolePermissionMigration.service.js";

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--apply" || argument === "--verify") {
      if (options.mode) throw new Error("Choose exactly one of --apply or --verify");
      options.mode = argument.slice(2);
      continue;
    }
    if (["--business-name", "--actor-id", "--map"].includes(argument)) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }
      options[argument.slice(2)] = value;
      index += 1;
      continue;
    }
    if (argument === "--help") {
      options.help = true;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }
  return options;
}

function usage() {
  console.log(
    "Usage: npm run rbac:compatibility -- --business-name <scope> --map <reviewed-json> (--apply --actor-id <active-super-admin-id>|--verify)",
  );
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  if (
    !options.mode ||
    !options["business-name"] ||
    (options.mode === "apply" && !options["actor-id"]) ||
    !options.map
  ) {
    usage();
    throw new Error("All migration options are required");
  }
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI is required");
  }

  const mappingPath = path.resolve(process.cwd(), options.map);
  const permissionsByRole = validateCompatibilityPermissionMap(
    JSON.parse(await readFile(mappingPath, "utf8")),
  );
  await mongoose.connect(process.env.MONGO_URI);
  try {
    const result = options.mode === "apply"
      ? await seedRolePermissionCompatibility({
          businessName: options["business-name"],
          actorId: options["actor-id"],
          permissionsByRole,
        })
      : await verifyRolePermissionCompatibility({
          businessName: options["business-name"],
          permissionsByRole,
        });
    console.log(JSON.stringify({ mode: options.mode, ...result }, null, 2));
    if (!result.ready) {
      throw new Error(
        "Compatibility verification failed; review the listed policies before granting access",
      );
    }
  } finally {
    await mongoose.disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
