import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

function receiptPath(receiptDirectory, requestDigest) {
  if (!path.isAbsolute(receiptDirectory)) {
    throw new Error("PRODUCTION_BACKUP_RECEIPT_DIRECTORY_NOT_ABSOLUTE");
  }
  if (!/^[a-f0-9]{64}$/.test(String(requestDigest || ""))) {
    throw new Error("PRODUCTION_BACKUP_RECEIPT_DIGEST_INVALID");
  }
  return path.join(receiptDirectory, `${requestDigest}.json`);
}

function ensurePrivateReceiptDirectory(receiptDirectory) {
  if (!path.isAbsolute(receiptDirectory) || receiptDirectory === path.parse(receiptDirectory).root) {
    throw new Error("PRODUCTION_BACKUP_RECEIPT_DIRECTORY_UNSAFE");
  }
  mkdirSync(receiptDirectory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(receiptDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("PRODUCTION_BACKUP_RECEIPT_DIRECTORY_UNSAFE");
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error("PRODUCTION_BACKUP_RECEIPT_DIRECTORY_OWNER_INVALID");
  }
  chmodSync(receiptDirectory, 0o700);
}

export function readProductionBackupReceipt({ plan, receiptDirectory }) {
  const target = receiptPath(receiptDirectory, plan.requestDigest);
  if (!existsSync(target)) return null;
  const stat = lstatSync(target);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size <= 0 ||
    stat.size > 64 * 1024 ||
    (stat.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  ) {
    throw new Error("PRODUCTION_BACKUP_RECEIPT_FILE_UNSAFE");
  }
  const parsed = JSON.parse(readFileSync(target, "utf8"));
  if (
    parsed?.contractVersion !== plan.contractVersion ||
    parsed?.requestDigest !== plan.requestDigest ||
    parsed?.backupName !== plan.backupName ||
    JSON.stringify(parsed?.exactTarget) !== JSON.stringify(plan.exactTarget) ||
    !["CLAIMED", "WORKFLOW_ACCEPTED", "VERIFIED", "FAILED"].includes(
      String(parsed?.status || "")
    )
  ) {
    throw new Error("PRODUCTION_BACKUP_RECEIPT_BINDING_INVALID");
  }
  return parsed;
}

export function claimProductionBackupReceipt({ plan, receiptDirectory }) {
  ensurePrivateReceiptDirectory(receiptDirectory);
  const target = receiptPath(receiptDirectory, plan.requestDigest);
  const claimedAt = new Date().toISOString();
  const claim = {
    contractVersion: plan.contractVersion,
    requestDigest: plan.requestDigest,
    backupName: plan.backupName,
    exactTarget: plan.exactTarget,
    status: "CLAIMED",
    claimedAt,
    updatedAt: claimedAt,
    workflowId: null,
    backupId: null,
  };
  try {
    const descriptor = openSync(target, "wx", 0o600);
    try {
      writeFileSync(descriptor, `${JSON.stringify(claim, null, 2)}\n`, {
        encoding: "utf8",
      });
    } finally {
      closeSync(descriptor);
    }
    chmodSync(target, 0o600);
    return { receipt: claim, created: true, path: target };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    return {
      receipt: readProductionBackupReceipt({ plan, receiptDirectory }),
      created: false,
      path: target,
    };
  }
}

export function updateProductionBackupReceipt({
  plan,
  receiptDirectory,
  changes,
}) {
  const current = readProductionBackupReceipt({ plan, receiptDirectory });
  if (!current) throw new Error("PRODUCTION_BACKUP_RECEIPT_MISSING");
  const next = {
    ...current,
    ...changes,
    updatedAt: new Date().toISOString(),
  };
  const target = receiptPath(receiptDirectory, plan.requestDigest);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    chmodSync(temporary, 0o600);
    renameSync(temporary, target);
    chmodSync(target, 0o600);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return next;
}
