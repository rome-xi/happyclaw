"use strict";

const os = require("os");
const crypto = require("crypto");

// ── Bun 兼容的属性重定义 helper ───────────────────────────────
// claude 是 Bun binary，os/fs/child_process 等内置模块的属性只读，
// 直接 `os.hostname = fn` 会抛 TypeError: Attempted to assign to readonly property。
// Object.defineProperty 在 Bun 下可正常重定义（实测 OK），故统一走这里。
function define(target, key, value) {
  try {
    Object.defineProperty(target, key, { value: value, configurable: true, writable: true });
    return;
  } catch (_) {}
  try { target[key] = value; } catch (_) {}
}

// ── 配置：伪装成的目标设备信息 ──────────────────────────────────
// 可通过环境变量覆盖，也可以直接改这里的默认值

const SPOOF = {
  hostname: process.env.SPOOF_HOSTNAME || "cloud-vm-" + crypto.randomBytes(3).toString("hex"),
  username: process.env.SPOOF_USERNAME || "user",
  homedir:  process.env.SPOOF_HOMEDIR  || "/home/user",
  platform: process.env.SPOOF_PLATFORM || "linux",
  type:     process.env.SPOOF_TYPE     || "Linux",
  release:  process.env.SPOOF_RELEASE  || "6.8.0-45-generic",
  arch:     process.env.SPOOF_ARCH     || os.arch(),
  machine:  process.env.SPOOF_MACHINE  || os.arch() === "arm64" ? "aarch64" : "x86_64",
  tmpdir:   process.env.SPOOF_TMPDIR   || "/tmp",
  shell:    process.env.SPOOF_SHELL    || "/bin/bash",

  // 伪造一个稳定的 MAC 地址（基于 hostname 派生，保证同一 hostname 总是同一个 MAC）
  mac: process.env.SPOOF_MAC || (() => {
    const h = process.env.SPOOF_HOSTNAME || "cloud-vm-default";
    const hash = crypto.createHash("sha256").update(h).digest("hex");
    return [
      "02", // locally administered bit
      hash.slice(0, 2),
      hash.slice(2, 4),
      hash.slice(4, 6),
      hash.slice(6, 8),
      hash.slice(8, 10),
    ].join(":");
  })(),

  cpuModel: process.env.SPOOF_CPU_MODEL || "AMD EPYC 7763 64-Core Processor",
  cpuCores: parseInt(process.env.SPOOF_CPU_CORES || "4", 10),
  totalMem: parseInt(process.env.SPOOF_TOTAL_MEM || String(8 * 1024 * 1024 * 1024), 10),
};

// ── Patch os.hostname() ────────────────────────────────────────
define(os, "hostname", () => SPOOF.hostname);

// ── Patch os.userInfo() ────────────────────────────────────────
const _userInfo = os.userInfo.bind(os);
define(os, "userInfo", (opts) => {
  const real = _userInfo(opts);
  return {
    ...real,
    username: SPOOF.username,
    homedir: SPOOF.homedir,
    shell: SPOOF.shell,
  };
});

// ── Patch os.platform() / os.type() / os.release() ────────────
define(os, "platform", () => SPOOF.platform);
define(os, "type", () => SPOOF.type);
define(os, "release", () => SPOOF.release);
define(os, "arch", () => SPOOF.arch);
define(os, "tmpdir", () => SPOOF.tmpdir);

// ── Patch os.totalmem() / os.freemem() ─────────────────────────
define(os, "totalmem", () => SPOOF.totalMem);
define(os, "freemem", () => Math.floor(SPOOF.totalMem * 0.6));

// ── Patch os.cpus() ────────────────────────────────────────────
define(os, "cpus", () =>
  Array.from({ length: SPOOF.cpuCores }, (_, i) => ({
    model: SPOOF.cpuModel,
    speed: 2450,
    times: { user: 100000 + i * 1000, nice: 0, sys: 50000, idle: 900000, irq: 0 },
  }))
);

// ── Patch os.networkInterfaces() ───────────────────────────────
define(os, "networkInterfaces", () => ({
  eth0: [
    {
      address: "10.0.0.2",
      netmask: "255.255.255.0",
      family: "IPv4",
      mac: SPOOF.mac,
      internal: false,
      cidr: "10.0.0.2/24",
    },
  ],
  lo: [
    {
      address: "127.0.0.1",
      netmask: "255.0.0.0",
      family: "IPv4",
      mac: "00:00:00:00:00:00",
      internal: true,
      cidr: "127.0.0.1/8",
    },
  ],
}));

// ── Patch os.homedir() ─────────────────────────────────────────
define(os, "homedir", () => SPOOF.homedir);

// ── Patch os.uptime() ──────────────────────────────────────────
const fakeBootTime = Date.now() - (7 * 24 * 3600 * 1000 + Math.random() * 3600000);
define(os, "uptime", () => Math.floor((Date.now() - fakeBootTime) / 1000));

// ── Patch process 属性 ─────────────────────────────────────────
// process.platform / process.arch 在 Node/Bun 下都不能直接赋值，走 defineProperty。
try {
  Object.defineProperty(process, "platform", { value: SPOOF.platform, configurable: true });
} catch (_) {
  // 某些环境不允许修改，忽略
}
try {
  Object.defineProperty(process, "arch", { value: SPOOF.arch, configurable: true });
} catch (_) {}

// ── 拦截 child_process 中的指纹命令 ────────────────────────────
// macOS 上 ioreg / system_profiler / sysctl 可能被用来获取硬件序列号
const childProcess = require("child_process");

const FINGERPRINT_COMMANDS = [
  { pattern: /ioreg.*IOPlatformSerialNumber/, replacement: '"IOPlatformSerialNumber" = "CLOUD000000"' },
  { pattern: /system_profiler\s+SPHardwareDataType/, replacement: "Serial Number (system): CLOUD000000\nHardware UUID: 00000000-0000-0000-0000-000000000000" },
  { pattern: /sysctl\s+kern\.uuid/, replacement: "kern.uuid: 00000000-0000-0000-0000-000000000000" },
  { pattern: /cat\s+\/etc\/machine-id/, replacement: crypto.createHash("sha256").update(SPOOF.hostname).digest("hex").slice(0, 32) },
  { pattern: /hostname/, replacement: SPOOF.hostname },
];

function maybeSpoofCommand(cmd) {
  for (const { pattern, replacement } of FINGERPRINT_COMMANDS) {
    if (pattern.test(cmd)) {
      return replacement;
    }
  }
  return null;
}

const _execSync = childProcess.execSync;
define(childProcess, "execSync", function (cmd, opts) {
  const spoofed = maybeSpoofCommand(String(cmd));
  if (spoofed !== null) return Buffer.from(spoofed + "\n");
  return _execSync.call(this, cmd, opts);
});

const _exec = childProcess.exec;
define(childProcess, "exec", function (cmd, opts, cb) {
  if (typeof opts === "function") { cb = opts; opts = {}; }
  const spoofed = maybeSpoofCommand(String(cmd));
  if (spoofed !== null) {
    const { EventEmitter } = require("events");
    const fake = new EventEmitter();
    fake.stdout = new EventEmitter();
    fake.stderr = new EventEmitter();
    process.nextTick(() => {
      fake.stdout.emit("data", spoofed + "\n");
      fake.emit("close", 0);
      if (cb) cb(null, spoofed + "\n", "");
    });
    return fake;
  }
  return _exec.call(this, cmd, opts, cb);
});

const _execFileSync = childProcess.execFileSync;
define(childProcess, "execFileSync", function (file, args, opts) {
  const fullCmd = [file, ...(args || [])].join(" ");
  const spoofed = maybeSpoofCommand(fullCmd);
  if (spoofed !== null) return Buffer.from(spoofed + "\n");
  return _execFileSync.call(this, file, args, opts);
});

const _spawnSync = childProcess.spawnSync;
define(childProcess, "spawnSync", function (cmd, args, opts) {
  const fullCmd = [cmd, ...(args || [])].join(" ");
  const spoofed = maybeSpoofCommand(fullCmd);
  if (spoofed !== null) {
    return { stdout: Buffer.from(spoofed + "\n"), stderr: Buffer.from(""), status: 0, signal: null, pid: 0, output: [null, Buffer.from(spoofed + "\n"), Buffer.from("")] };
  }
  return _spawnSync.call(this, cmd, args, opts);
});

// ── 拦截 fs 层 machine-id 读取 ────────────────────────────────
const fs = require("fs");
const MACHINE_ID_PATHS = ["/etc/machine-id", "/var/lib/dbus/machine-id"];
function isMachineIdPath(p) {
  const s = typeof p === "string" ? p : (p && p.toString ? p.toString() : "");
  return MACHINE_ID_PATHS.includes(s);
}
const fakeMachineId = crypto.createHash("sha256").update(SPOOF.hostname).digest("hex").slice(0, 32) + "\n";

const _origReadFileSync = fs.readFileSync.bind(fs);
define(fs, "readFileSync", function (path, options) {
  if (isMachineIdPath(path)) {
    return typeof options === "string" || (options && options.encoding)
      ? fakeMachineId : Buffer.from(fakeMachineId);
  }
  return _origReadFileSync(path, options);
});

const _origReadFile = fs.readFile.bind(fs);
define(fs, "readFile", function (path, ...args) {
  if (isMachineIdPath(path)) {
    const cb = typeof args[args.length - 1] === "function" ? args[args.length - 1] : null;
    if (cb) {
      const opts = args.length > 1 ? args[0] : null;
      const data = typeof opts === "string" || (opts && opts.encoding) ? fakeMachineId : Buffer.from(fakeMachineId);
      process.nextTick(cb, null, data);
      return;
    }
  }
  return _origReadFile(path, ...args);
});

try {
  const fsp = fs.promises || require("fs/promises");
  if (fsp && fsp.readFile) {
    const _origPromiseReadFile = fsp.readFile.bind(fsp);
    define(fsp, "readFile", function (path, options) {
      if (isMachineIdPath(path)) {
        const data = typeof options === "string" || (options && options.encoding) ? fakeMachineId : Buffer.from(fakeMachineId);
        return Promise.resolve(data);
      }
      return _origPromiseReadFile(path, options);
    });
  }
} catch (_) {}

// ── 容器检测绕过 ─────────────────────────────────────────────
const _origExistsSync = fs.existsSync.bind(fs);
define(fs, "existsSync", function (p) {
  const s = typeof p === "string" ? p : (p && p.toString ? p.toString() : "");
  if (s === "/.dockerenv") return false;
  return _origExistsSync(p);
});

// cgroup 文件改写：抹掉 docker/containerd/kubepods 痕迹（链在 machine-id 拦截之上）
const _origReadFileSyncCg = fs.readFileSync;
define(fs, "readFileSync", function (path, options) {
  const s = typeof path === "string" ? path : (path && path.toString ? path.toString() : "");
  if (s === "/proc/1/cgroup") {
    const content = _origReadFileSyncCg(path, options);
    const str = typeof content === "string" ? content : content.toString();
    return typeof options === "string" || (options && options.encoding)
      ? str.replace(/docker|containerd|kubepods/gi, "system.slice")
      : Buffer.from(str.replace(/docker|containerd|kubepods/gi, "system.slice"));
  }
  return _origReadFileSyncCg(path, options);
});

// ── 日志（调试时打开） ────────────────────────────────────────
if (process.env.SPOOF_DEBUG === "1") {
  console.error("[spoof-fingerprint] Loaded. Spoofing as:", JSON.stringify({
    hostname: SPOOF.hostname,
    platform: SPOOF.platform,
    username: SPOOF.username,
    mac: SPOOF.mac,
    cpuModel: SPOOF.cpuModel,
    cpuCores: SPOOF.cpuCores,
    totalMem: SPOOF.totalMem,
  }, null, 2));
}
