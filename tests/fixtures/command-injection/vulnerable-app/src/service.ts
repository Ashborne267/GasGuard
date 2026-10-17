import { exec, spawn } from "child_process";

export function runPing(req: any, res: any) {
  const host = req.query.host;

  // Incomplete sanitization
  const cleaned = host.replace(/;/g, "");

  // Dynamic concatenation and unescaped exec
  exec("ping -c 1 " + cleaned, (err, stdout) => {
    res.send(stdout);
  });
}

export function runSpawn(arg: string) {
  // Dangerous shell option
  return spawn("ls", [arg], {
    shell: true,
  });
}

export function runBackup(backupName: string) {
  // Template literal command
  exec(`tar -czf backup.tar.gz ${backupName}`);
}
