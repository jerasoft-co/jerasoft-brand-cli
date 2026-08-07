import { z } from "zod";

export const semverSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
}

export function parseSemver(version: string): ParsedSemver {
  const parsed = semverSchema.parse(version).split(".").map(Number);
  const [major, minor, patch] = parsed;
  if (major === undefined || minor === undefined || patch === undefined) {
    throw new Error("Informe uma versão SemVer completa.");
  }
  return {
    major,
    minor,
    patch,
  };
}

export function compareSemver(left: string, right: string) {
  const leftVersion = parseSemver(left);
  const rightVersion = parseSemver(right);
  for (const key of ["major", "minor", "patch"] as const) {
    if (leftVersion[key] !== rightVersion[key]) {
      return Math.sign(leftVersion[key] - rightVersion[key]);
    }
  }
  return 0;
}
