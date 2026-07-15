import { spawn } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";

const STRYKER_SETUP_PATTERN = /^stryker-setup-\d+\.js$/;

const removeStrykerSetupFiles = (): void => {
  for (const fileName of readdirSync(process.cwd())) {
    if (STRYKER_SETUP_PATTERN.test(fileName)) {
      rmSync(fileName, { force: true });
    }
  }
};

const runStryker = (args: readonly string[]): Promise<number> =>
  new Promise((resolve, reject) => {
    const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    const child = spawn(pnpmCommand, ["exec", "stryker", "run", ...args], {
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });

const main = async (): Promise<void> => {
  process.once("exit", removeStrykerSetupFiles);

  try {
    process.exitCode = await runStryker(process.argv.slice(2));
  } finally {
    removeStrykerSetupFiles();
    process.removeListener("exit", removeStrykerSetupFiles);
  }
};

void main().catch((error: unknown) => {
  removeStrykerSetupFiles();
  console.error(error);
  process.exitCode = 1;
});
