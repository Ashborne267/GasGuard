import { execFile } from "child_process";

export function safeGitStatus() {
  execFile("git", ["status"], (err, stdout) => {
    console.log(stdout);
  });
}

export function safeExecWithSanitizer(rawArg: string) {
  const safe = escapeShellArg(rawArg);
  execFile("ls", [safe]);
}

function escapeShellArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}
